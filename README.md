## Building

It's recommended to use Clojure version 1.10.x and JVM 11.

### Config

The configuration of the node is read from a few different places. On
a production environment the configuration values are passed as
enironment variables. Locally it is most convenient to use the
`~/.nosana-node-config.edn` file:

```
cp nosana-node-config.edn-TEMPLATE ~/.nosana-node-config.edn
```

In development you will only have to enter you node's NFT address in
the `.nosana-node-config.edn` and you're good-to-go. If you do not
have a default Solana keypair yet you can generate one with:

```
solana-keygen new
```

| Name            | Description                                    | ENV                     | Default                                |
|-----------------|------------------------------------------------|-------------------------|----------------------------------------|
| **Private key** | **Private key for the node**                   | `SOLANA_PRIVATE_KEY`    | Read from `~/.config/solana/id.jon`    |
| **NFT**         | **Address of the NFT of the node**             | `NOSANA_NFT`            | In `~/.nosana-node-config.edn`         |
| Network         | Solana network to use                          | `SOLANA_NETWORK`        | In `~/.nosana-node-config.edn`         |
| Podman          | Connection string to Podman                    | `PODMAN_CONN_URI`       | `"http://localhost8080"`               |
| Pinata JWT      | Access token for IPFS pinning                  | `PINATA_JWT`            | In `~/.nosana-node-config.edn`         |
| Market          | Address of the Nosana market to use            | `NOSANA_MARKET`         | In `~/.nosana-node-config.edn`         |
| NFT Collection  | Address of the NFT collection                  | `NOSANA_NFT_COLLECTION` | In `~/.nosana-node-config.edn`         |
| IPFS Url        | URL downloading IPFS content                   | `IPFS_URL`              | `"https://nosana.mypinata.cloud/ipfs"` |
| Job loop        | If the node should automatically poll for jobs | -                       | Only enabled in `prod`                 |
| Poll delay      | How often to poll for jobs in ms               | `NOSANA_POLL_DELAY_MS`  | `30000`                                |

### Local development

This project includes [solanaj](https://github.com/p2p-org/solanaj) as
a git submodule, so you will have to clone this repository it
recursively.

The solanaj classes have to be compiled once before we start:

```
clj -X:compile
```

To quickly start a development repl, and spin up the node:

```
$ clj -M:dev -r
Clojure 1.10.0
user=> (go)
```

This will print the node configuration and check if it's healthy.

### Docker

We use [jibbit](https://github.com/atomisthq/jibbit) to build a
container image on the JVM without a Docker daemon.

To build a docker container and import it to your local docker daemon,
tagged as `nos/node`:

```
clj -T:container "$(< jib-local.edn)"
```

The `jib.edn` file can be adjusted to push to a different registry or
supply a different tagger. For more info check the jibbit docs.

## Usage

### Start Podman

As a requirement you will have to run a local non-privileged Podman container:

```
docker run -d --name podman --device /dev/fuse --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt label=disable --cap-add sys_admin --cap-add mknod -p 8080:8080 quay.io/podman/stable bash -c 'dnf install -y socat && (podman system service -t 0 unix:///tmp/pod.sock &) && socat TCP-LISTEN:8080,fork UNIX-CONNECT:/tmp/pod.sock'
```

Podman will be used to spin up containers for Nosana jobs.



```
docker run --rm -it -e "SOLANA_PRIVATE_KEY=$(< ~/.config/solana/id.json)" -e "PODMAN_CONN_URI=http://$(docker inspect -f '{{ .NetworkSettings.IPAddress }}' podman):8080" nos/node
```
