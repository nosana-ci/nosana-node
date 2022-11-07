## Nosana Node Architecture

This document lays out the implementation details of the Nosana Node.

### Code layout

The node consists of the following core namespace:

- [`nosana-node.solana`](../src/nosana_node/solana.clj): This contains functions to interact with the Solana blockchain and also implements part of the Anchor protocol.
- [`nosana-node.nosana`](../src/nosana_node/nosana.clj): The core logic of the node for queueing, claiming, and finishing compute jobs.
- [`nosana-node.pipeline`](../src/nosana_node/pipeline.clj): Implementation of the Nosana pipeline format and conversion to other formats.

Besides that, [`nosana-node.main`](../src/nosana_node/main.clj) contains the main entrypoint of the node and [`user`](../dev/src/user.clj) defines the environment for the development REPL.

### Pipelines

The Nosana Node uses [Nostromo](https://github.com/nosana-ci/nostromo) to run pipelines.

Nostromo is a leightweight automation framework that manages long-running, composable, pipelines.

#### Nostromo Flows

A Nostromo `flow` is a sequence of `ops`.
An `op` can be any piece of executebale code, but Nosana Pipeliens are composed solely out of `:docker/run`.

```
{:id      "RiSNBpIY0CQokvl7hekJS"
 :results {}
 :ops     [{:op   :docker/run
            :id   :clone
            :args [{:cmds      [{:cmd "git clone https://github.com/unraveled/dummy.git"}
                                {:cmd "ls dummy"}]
                    :image     "registry.hub.docker.com/bitnami/git:latest"
                    :artifacts [{:source "dummy" :dest "dummy.tar"}]}]}
           {:op   :docker/run
            :id   :list
            :args [{:cmds      [{:cmd "ls -l"}]
                    :image     "ubuntu"
                    :resources [{:source "dummy.tar" :dest "/root"}]}]}]}
```

#### Nosana Pipelines

The Node maps the Nosnana Pipelines format to the flow structure.
For example, a Nosana pipeline always ensures there is a repo checked out by prepending a `clone` and `checkout` operator to the flow.

#### Pipeline result format

When a Nostormo pipeline is finished the node converts the flow results to a pipeline results file.

An example of such a file can be [found here](https://nosana.mypinata.cloud/ipfs/QmSrVUQviKqooVxxovEqK9ZNhGuDW1ygErjV6TKb8ieaTh).

The result file looks like this:

```json
{"nos-id": "uG8-ItAzmR5aOPvolW5PZ",
 "finished-at": 1667813653,
 "results":
 {"checkout": ["success",
               [{"img":"01da4c8e09c7a3178f24cf3a8ee707f894b8c6dbda441404e60805b936aea53e",
                 "cmd":null,
                 "time":1667813625,
                 "log":null},
                {"img":"756e7eb2c0654696b99a9cc6abedb3c4de4abf67466a41dc17d9fdcb3c38cd6c",
                 "container":"07011fec6686d765ee51edad46d040942bed6b38ac66dc523ba929bbb378e7d8",
                 "time":1667813627,
                 "cmd":{"cmd":"git clone https://github.com/unraveled/dummy.git project"},
                 "log":[[2,"Cloning into 'project'...\n"],[1,""]]}]]}}
```

And has the following structure:

```json
{"nos-id": <internal id for the node>
 "finished-at": <timestamp the pipeline finished>,
 "results": <object with the pipeline results, every key is a step in the pipeline, this is unordered>
 {"checkout": ["success",   <the result entry is a tuple: "success" or "pipeline-failed">
               [<the second element is the result of each command in this step>
                {"img": <this is the docker image ID used for this step. this can safely be ignored>
                 "cmd": <the command run. the first entry always contains the "bootstrap" docker image and `null` cmd and log>
                 "time": <timestamp this command begin execution>,
                 "log": <an array of log entry tuples>},
                {"img": <the results of the second command>
                 "container": <container can safely be ignored. should it be removed from results?>
                 "time": <the UNIX timestamp this cmd began running>,
                 "cmd": <the cmd entry is an object with at last a "cmd" entry>
                 "log": <each tuple in the log vector contains the status code (1=STDOUT, 2=STDERR) and the log value>}]]}}
```

### Secrets

The Nosana Node uses a [config file](../resources/config.edn) to store secrets.
This file uses [aero](https://github.com/juxt/aero) to load environment variables and local private files.
The config file is available as a Nostromo Vault, so flows can reference values using `[:nos.core/vault :secret-key-id]`,
Secret values get injected in the pipeline only at the very end, right before they are run.

This is an area of development:
at the moment the Nosana Pipeline format does not support secrets yet, and the Node still has to implement other backends its Vault.
