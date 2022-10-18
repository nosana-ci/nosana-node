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

### Secrets

The Nosana Node uses a [config file](../resources/config.edn) to store secrets.
This file uses [aero](https://github.com/juxt/aero) to load environment variables and local private files.
The config file is available as a Nostromo Vault, so flows can reference values using `[:nos.core/vault :secret-key-id]`,
Secret values get injected in the pipeline only at the very end, right before they are run.

This is an area of development:
at the moment the Nosana Pipeline format does not support secrets yet, and the Node still has to implement other backends its Vault.
