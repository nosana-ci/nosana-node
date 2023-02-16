sudo docker run -d \
  --name podman \
  --device /dev/fuse \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt label=disable \
  --cap-add sys_admin \
  --cap-add mknod \
  -p 8080:8080 \
  quay.io/podman/stable podman system service \
  --time 0 tcp:0.0.0.0:8080