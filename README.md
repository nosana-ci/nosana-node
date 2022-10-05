## Building

It's recommended to use Clojure version 1.10.x and JVM 11.

### Local development

This project includes [solanaj](https://github.com/p2p-org/solanaj)
as a git submodule, so you will have to clone it recursively.

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

### Docker

We use [jibbit](https://github.com/atomisthq/jibbit) to build a
container image on the JVM, without a Docker daemon.

This command will build a docker container and import it to your local
docker daemon, tagged as `nos/node`:

```
clj -T:container "$(< jib-local.edn)"
```

The `jib.edn` file can be adjusted to push to different registry or
supply a different tagger. For more info check the jibbit docs.

## Usage

### Local machine with Docker

As a requirement you will have to run a local non-privileged podman container:

```
docker run -d --name podman --device /dev/fuse --security-opt seccomp=unconfined --security-opt apparmor=unconfined --security-opt label=disable --cap-add sys_admin --cap-add mknod -p 8080:8080 quay.io/podman/stable bash -c 'dnf install -y socat && (podman system service -t 0 unix:///tmp/pod.sock &) && socat TCP-LISTEN:8080,fork UNIX-CONNECT:/tmp/pod.sock'
```

Podman will be used to spin up containers for Nosana jobs. It should also be
possible to run nosana-node as a privileged container using Docker to manage
sub-containers, but this is not yet tested.

When running the node you will have to pass the Solana private key of your node
the the connection to podman:

```
docker run --rm -it -e "SOLANA_PRIVATE_KEY=$(< ~/.config/solana/id.json)" -e "PODMAN_CONN_URI=http://$(docker inspect -f '{{ .NetworkSettings.IPAddress }}' podman):8080" nos/node
```
