# Nosana NODE

The Nosana NODE is a command-line tool for interacting with the [Nosana Network](https://nosana.com), enabling users to run a Nosana Node.

---

## Features

- **Run a Node**: Set up and manage a Nosana Node.

## Install

```shell
$ npm install -g @nosana/node

# or install with yarn
$ yarn global add @nosana/node
```

**HINT**\
Alternatively, you can use `npx` to use the node directly without installing it globally:

```shell
$ npx @nosana/node help
```

## Basic Usage

Once installed, you can invoke NODE commands directly from your OS command line through the `nosana-node` executable. See the available commands by entering the following:

```shell
$ nosana-node help
```

All interactions with Nosana NODE are of the form

```shell
$ nosana [command] [options] [argument]
```

Available `node` commands:

```
node start [options] <market>             Start Nosana Node
node run [options] <job-definition-file>  Run Job Definition File
node help [command]                       display help for command
```

Global options:

```
-V, --version                        output the version number
-n, --network <network>              network to run on (choices: "devnet", "mainnet", default: "mainnet")
--rpc <url>                          RPC node to use
--log <logLevel>                     Log level (choices: "info", "none", "debug", "trace", default: "debug")
```

## Start a Nosana Node

To get started with your Nosana Node on the Nosana Grid, you can run a node after you've installed the prerequisites with the following command:

`nosana node start [options]`

Options:

```
  --provider <provider>     provider used to run the job (choices: "docker", "podman", default: "podman")
  -w, --wallet <wallet>     path to wallet private key (default: "~/.nosana/nosana_key.json")
  --docker, --podman <URI>  Podman/Docker connection URI (default: "~/.nosana/podman/podman.sock")
  -h, --help                display help for command
```

## Starting node

With the `nosana node start [options]` command you can start a Nosana Node and join the Nosana Network.

Options:

```
  --provider <provider>     provider used to run the job (choices: "docker", "podman", default: "podman")
  -w, --wallet <wallet>     path to wallet private key (default: "~/.nosana/nosana_key.json")
  --docker, --podman <URI>  Podman/Docker connection URI (default: "~/.nosana/podman/podman.sock")
  -h, --help                display help for command
```

## Documentation

Please [visit our documentation](https://learn.nosana.com/) for a full list of commands and examples.

For technical details on how the Nosana NODE works, refer to the technical documentation:

[Technical Documentation](https://github.com/nosana-ci/nosana-node/tree/main/docs)
