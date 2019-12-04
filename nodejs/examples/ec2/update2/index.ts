// Copyright 2016-2018, Pulumi Corporation.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import { Config } from "@pulumi/pulumi";

export default async () => {
    const config1 = new pulumi.Config("aws");
    const providerOpts = { provider: new aws.Provider("prov", { region: <aws.Region>config1.require("envRegion") }) };

    console.log("EC2: Update2");

    const vpc = await awsx.ec2.Vpc.create("testing-1", {}, providerOpts);
    const cluster1 = await awsx.ecs.Cluster.create("testing-1", { vpc }, providerOpts);

    const autoScalingGroup = await cluster1.createAutoScalingGroup("testing-1", {
        subnetIds: vpc.publicSubnetIds,
        templateParameters: {
            minSize: 5,
        },
        launchConfigurationArgs: {
            instanceType: "m5.large",
            associatePublicIpAddress: true,
        },
    });

    // Schedule the ASG to go up to 20 instances at 6am, and back down to 10 at 10pm.
    autoScalingGroup.scaleOnSchedule("scaleUpAt6amUTC", {
        minSize: 20,
        recurrence: { hour: 6 },
    });
    autoScalingGroup.scaleOnSchedule("scaleUpAt6amUTC", {
        minSize: 10,
        recurrence: { hour: 22 },
    });

    // A simple NGINX service, scaled out over two containers.
    const nginxListener = await awsx.lb.NetworkListener.create("nginx", { vpc, port: 80 }, providerOpts);
    const nginx = await awsx.ecs.EC2Service.create("nginx", {
        cluster: cluster1,
        taskDefinitionArgs: {
            containers: {
                nginx: {
                    image: "nginx",
                    memory: 64,
                    portMappings: [nginxListener],
                },
            },
        },
        desiredCount: 1,
    }, providerOpts);

    const nginxEndpoint = nginxListener.endpoint;

    // A simple NGINX service, scaled out over two containers, starting with a task definition.
    const simpleNginxListener = await awsx.lb.NetworkListener.create("simple-nginx", { vpc, port: 80 }, providerOpts);
    const simpleNginxTask = await awsx.ecs.EC2TaskDefinition.create("simple-nginx", {
        container: {
            image: "nginx",
            memory: 64,
            portMappings: [simpleNginxListener],
        },
    }, providerOpts);
    const simpleNginx = await simpleNginxTask.createService("examples-simple-nginx", { cluster: cluster1, desiredCount: 1});

    const simpleNginxEndpoint = simpleNginxListener.endpoint;

    const cachedNginx = await awsx.ecs.EC2Service.create("cached-nginx", {
        cluster: cluster1,
        taskDefinitionArgs: {
            containers: {
                nginx: {
                    image: awsx.ecs.Image.fromDockerBuild("cached-nginx", {
                        context: "./app",
                        cacheFrom: true,
                    }),
                    memory: 64,
                    portMappings: [await awsx.lb.NetworkListener.create(
                        "cached-nginx", { vpc, port: 80 }, providerOpts)],
                },
            },
        },
        desiredCount: 1,
    }, providerOpts);

    const multistageCachedNginx = await awsx.ecs.EC2Service.create("multistage-cached-nginx", {
        cluster: cluster1,
        taskDefinitionArgs: {
            containers: {
                nginx: {
                    image: awsx.ecs.Image.fromDockerBuild("multistage-cached-nginx", {
                        context: "./app",
                        dockerfile: "./app/Dockerfile-multistage",
                        cacheFrom: {stages: ["build"]},
                    }),
                    memory: 64,
                    portMappings: [await awsx.lb.NetworkListener.create(
                        "multistage-cached-nginx", { vpc, port: 80 }, providerOpts)],
                },
            },
        },
        desiredCount: 1,
    }, providerOpts);

    const customServerTG = await awsx.lb.NetworkTargetGroup.create("custom", { vpc, port: 8080 }, providerOpts);
    const customWebServerListener = await customServerTG.createListener("custom", { port: 80 });

    const customWebServer = await awsx.ecs.EC2Service.create("custom", {
        cluster: cluster1,
        taskDefinitionArgs: {
            containers: {
                webserver: {
                    memory: 64,
                    portMappings: [customWebServerListener],
                    image: awsx.ecs.Image.fromFunction(() => {
                        const rand = Math.random();
                        const http = require("http");
                        http.createServer((req: any, res: any) => {
                            res.end(`Hello, world! (from ${rand})`);
                        }).listen(8080);
                    }),
                },
            },
        },
        desiredCount: 1,
    }, providerOpts);

    const config = new Config("containers");
    const redisPassword = config.require("redisPassword");

    /**
     * A simple Cache abstration, built on top of a Redis container Service.
     */
    class Ec2Cache {
        get!: (key: string) => Promise<string>;
        set!: (key: string, value: string) => Promise<void>;

        async initialize(name: string, memory: number = 128) {
            const redisListener = await awsx.lb.NetworkListener.create(name, { vpc, port: 6379 }, providerOpts);
            const redis = await awsx.ecs.EC2Service.create(name, {
                cluster: cluster1,
                taskDefinitionArgs: {
                    containers: {
                        redis: {
                            image: "redis:alpine",
                            memory: memory,
                            portMappings: [redisListener],
                            command: ["redis-server", "--requirepass", redisPassword],
                        },
                    },
                },
            }, providerOpts);

            this.get = (key: string) => {
                const endpoint = redisListener.endpoint.get();
                console.log(`Endpoint: ${JSON.stringify(endpoint)}`);
                const client = require("redis").createClient(
                    endpoint.port,
                    endpoint.hostname,
                    { password: redisPassword },
                );
                console.log(client);
                return new Promise<string>((resolve, reject) => {
                    client.get(key, (err: any, v: any) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(v);
                        }
                    });
                });
            };
            this.set = (key: string, value: string) => {
                const endpoint = redisListener.endpoint.get();
                console.log(`Endpoint: ${JSON.stringify(endpoint)}`);
                const client = require("redis").createClient(
                    endpoint.port,
                    endpoint.hostname,
                    { password: redisPassword },
                );
                console.log(client);
                return new Promise<void>((resolve, reject) => {
                    client.set(key, value, (err: any, v: any) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            };
        }
    }

    const cache = new Ec2Cache();
    await cache.initialize("mycache");

    const helloTask = await awsx.ecs.EC2TaskDefinition.create("hello-world", {
        container: {
            image: "hello-world",
            memory: 20,
        },
    }, providerOpts);

    // build an anonymous image:
    const builtServiceListener = await awsx.lb.NetworkListener.create("nginx2", { vpc, port: 80 }, providerOpts);
    const builtService = await awsx.ecs.EC2Service.create("nginx2", {
        cluster: cluster1,
        taskDefinitionArgs: {
            containers: {
                nginx: {
                    image: awsx.ecs.Image.fromPath("nginx2", "./app"),
                    memory: 64,
                    portMappings: [builtServiceListener],
                },
            },
        },
        desiredCount: 1,
        waitForSteadyState: false,
    }, providerOpts);

    function errorJSON(err: any) {
        const result: any = Object.create(null);
        Object.getOwnPropertyNames(err).forEach(key => result[key] = err[key]);
        return result;
    }

    function handleError(err: Error) {
        console.error(errorJSON(err));
        return {
            statusCode: 500,
            body: JSON.stringify(errorJSON(err)),
        };
    }

    // expose some APIs meant for testing purposes.
    const api = new awsx.apigateway.API("containers", {
        routes: [{
            path: "/test",
            method: "GET",
            eventHandler: async (req) => {
                try {
                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            nginx: nginxListener.endpoint.get(),
                            nginx2: builtServiceListener.endpoint.get(),
                        }),
                    };
                } catch (err) {
                    return handleError(err);
                }
            },
        }, {
            path: "/",
            method: "GET",
            eventHandler: async (req) => {
                try {
                    const fetch = (await import("node-fetch")).default;
                    // Use the NGINX or Redis Services to respond to the request.
                    console.log("handling /");
                    const page = await cache.get("page");
                    if (page) {
                        return {
                            statusCode: 200,
                            headers: { "X-Powered-By": "redis" },
                            body: page,
                        };
                    }

                    const endpoint = nginxListener.endpoint.get();
                    console.log(`got host and port: ${JSON.stringify(endpoint)}`);
                    const resp = await fetch(`http://${endpoint.hostname}:${endpoint.port}/`);
                    const buffer = await resp.buffer();
                    console.log(buffer.toString());
                    await cache.set("page", buffer.toString());

                    return {
                        statusCode: 200,
                        headers: { "X-Powered-By": "nginx" },
                        body: buffer.toString(),
                    };
                } catch (err) {
                    return handleError(err);
                }
            },
        }, {
            path: "/run",
            method: "GET",
            eventHandler: new aws.lambda.CallbackFunction("runRoute", {
                policies: [...awsx.ecs.TaskDefinition.defaultTaskRolePolicyARNs()],
                callback: async (req) => {
                    try {
                        const result = await helloTask.run({ cluster: cluster1 });
                        return {
                            statusCode: 200,
                            body: JSON.stringify({ success: true, tasks: result.tasks }),
                        };
                    } catch (err) {
                        return handleError(err);
                    }
                },
            }, providerOpts),
        }, {
            path: "/custom",
            method: "GET",
            eventHandler: async (req): Promise<awsx.apigateway.Response> => {
                try {
                    const fetch = (await import("node-fetch")).default;
                    const endpoint = customWebServerListener.endpoint.get();
                    console.log(`got host and port: ${JSON.stringify(endpoint)}`);
                    const resp = await fetch(`http://${endpoint.hostname}:${endpoint.port}/`);
                    const buffer = await resp.buffer();
                    console.log(buffer.toString());
                    await cache.set("page", buffer.toString());

                    return {
                        statusCode: 200,
                        headers: { "X-Powered-By": "custom web server" },
                        body: buffer.toString(),
                    };
                } catch (err) {
                    return handleError(err);
                }
            },
        }, {
            path: "/nginx",
            target: nginxListener,
        }],
    }, providerOpts);

    return {
        autoScalingGroupId: autoScalingGroup.stack.id,
        frontendURL: api.url,
        ec2VpcId: vpc.id,
        ec2PublicSubnets: vpc.publicSubnetIds,
        ec2PrivateSubnets: vpc.privateSubnetIds,
        ec2IsolatedSubnets: vpc.isolatedSubnetIds,
    };
};
