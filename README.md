## Building

### Docker

This command will build a docker container and import it to your local docker
daemon as `nos/node`:

```
clj -T:container "$(< jib-local.edn)"
```

## Running

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
