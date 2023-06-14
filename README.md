<h1 align="center">
  <br>
   <img width="400" src="https://nosana.io/img/Nosana_Logo_vertical_color_black.svg" />
  <br>
</h1>

# Nosana Node

Nosana container engine is used for running jobs on the Nosana network.
Learn more at [nosana.io](https://nosana.io).

## TL/DR

To get up and running with your own Nosana Node:

```bash
brew install nosana-ci/tools/nosana-node

nosana-node
```

## Building

It's recommended to use Clojure version 1.10.x and JVM 11.

### Config

The configuration of the node is read from a few different places.
In a production environment, the configuration values are passed as environment variables.
Locally it is most convenient to use the `~/.nosana-node-config.edn` file:
In development, you will only have to enter your node's NFT address in
the `.nosana-node-config.edn` and configure Solana and Pinata.

#### Solana

If you do not have a default Solana keypair yet you can generate one
with:

```bash
solana-keygen new
```

Make sure your Solana account has enough staked and holds an NFT.

#### Pinata

The node uses Pinata to upload job results to IPFS. If you do not have
Pinata credentials set your node will fail to upload job results and
get slashed. In the future, we will support multiple storage backends -
feel free to open a GitHub issue with suggestions.

For now, log in to Pinata and generate new API credentials with the
`pinJSONToIPFS` ability. Then copy the JWT value to your config.

#### Config overview

Below is the table of config values that can be set:

| Name            | Description                                    | ENV                    | Default                                |
|-----------------|------------------------------------------------|------------------------|----------------------------------------|
| **Private key** | **Private key for the node**                   | `SOLANA_PRIVATE_KEY`   | Read from `~/.config/solana/id.jon`    |
| **Market**      | **Address of the Nosana market to use**        | `NOSANA_MARKET`        | In `~/.nosana-node-config.edn`         |
| NFT             | Address of the NFT of the node                 | `NOSANA_NFT`           | In `~/.nosana-node-config.edn`         |
| Network         | Solana network to use                          | `SOLANA_NETWORK`       | In `~/.nosana-node-config.edn`         |
| Podman          | Connection string to Podman                    | `PODMAN_CONN_URI`      | `"http://localhost8080"`               |
| Pinata JWT      | Access token for IPFS pinning                  | `PINATA_JWT`           | In `~/.nosana-node-config.edn`         |
| IPFS Url        | URL downloading IPFS content                   | `IPFS_URL`             | `"https://nosana.mypinata.cloud/ipfs"` |
| Job loop        | If the node should automatically poll for jobs | -                      | Only enabled in `prod`                 |
| Poll delay      | How often to poll for jobs in ms               | `NOSANA_POLL_DELAY_MS` | `30000`                                |

### Local development

This project includes [SolanaJ](https://github.com/p2p-org/solanaj) as
a git submodule, so you will have to clone this repository
recursively.

The SolanaJ classes have to be compiled once before we start:

```bash
clj -X:compile
```

This compiles the SolanaJ class files and puts them in the `target`
folder. You can now [start a repl](#hacking-locally).

### Docker

We use [jibbit](https://github.com/atomisthq/jibbit) to build a
container image on the JVM without a Docker daemon.

To build a docker container and import it to your local docker daemon,
tagged as `nos/node`:

```bash
clj -T:container "$(< jib-local.edn)"
```

The `jib.edn` file can be adjusted to push to a different registry or
supply a different tagger. For more info check the [jibbit docs](https://github.com/atomisthq/jibbit).
For CI/CD the [jib-gitlab.edn](jib-gitlab.edn) file is used.

### UberJAR

The project can also be compiled as a standalone jar:

```bash
clj -X:compile uberjar
```

The resulting jar file can be run in a JVM like:

```bash
PODMAN_URI=localhost:8080 java -jar target/node-0.0.189-standalone.jar
```

## Usage

### Start Podman

You will have to run a local non-privileged, and rootless, Podman container, with `docker`:

```bash
(sudo) docker run -d \
  --name podman \
  --device /dev/fuse \
  --security-opt seccomp=unconfined \
  --user 1000:1000 \
  -p 8080:8080 \
  nosana/podman podman system service --time 0 tcp:0.0.0.0:8080
```

Podman will be used to spin up containers for Nosana jobs.

Alternatively, when you're using `containerd` as your container engine.
you may replace `docker` with `nerdctl` in the above command.

### Hacking locally

To quickly start a development REPL, and spin up the node:

```bash
clj -M:dev -r
# Clojure 1.10.0
# user=> (go)
```

Make sure that your node is healthy and fix any configuration issues
that are reported.

This is the fun part! You are now able to interact with the Nosana
network directly through this interface.

Here are some example commands to check. Note that our repl defined
the `conf` variable that contains the network configuration, and
`system` which contains all the components of the server:

```clojure
;; displays the current market and queue
user=> (nos/get-market conf)

;; see you if you have any jobs claimed
user=> (nos/find-my-runs conf)

;; enter the market queue
user=> (nos/enter-market conf)

;; or: just run the main loop, that will process jobs (polls after 30 seconds)
user=> (start-work-loop!)

;; to cancel the main loop
user=> (nos/exit-work-loop! system)

;; to list a compute job on the market
user=> (nos/list-job conf pl/example-job)

;; run an example pipeline from the repl
user=> (run-flow (flow/build (pl/load-yml (io/resource "pipeline2.yml"))))
```

If you want to test CLI arguments locally you can set an alias to your
local code base:

```bash
alias nos='clj -Sdeps "{:deps {nosana-node {:local/root \"/path/to/nosana-node\"}}}" -M -m nosana-node.main $@ '
nos --help
```

### Production nodes

Production nodes can run on any device with a JVM and Podman
available. For simplicity, we recommend running the node through
docker. Below is an example of how you could start a Docker-based Nosana node, in which you will have to fill out the correct environment variables:

```bash
docker run --rm -it \
  -e "SOLANA_PRIVATE_KEY=$(< ~/.config/solana/id.json)"
  -e "PODMAN_CONN_URI=http://$(docker inspect -f '{{ .NetworkSettings.IPAddress }}' podman):8080" \
  -e "NOSANA_NFT=nftaddress" \
  -e "SOLANA_NETWORK=mainnet" \
  -e "PINATA_JWT=jwtvalue" \
  nos/node
```
