# syntax=docker/dockerfile:1
# Two images from one file:
#   GPU=vulkan (default, tag latest)   CPU everywhere, plus Intel and AMD GPUs through /dev/dri
#   GPU=cuda   (tag latest-cuda)       CPU, plus NVIDIA GPUs from the GTX 900 series on
# whisper.cpp loads its backends at start-up and falls back to the CPU when no GPU is there.
ARG GPU=vulkan
ARG WHISPER_VERSION=v1.9.4

# ---------- whisper.cpp: CPU + Vulkan ----------
FROM debian:trixie-slim AS whisper-vulkan
ARG WHISPER_VERSION
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates libvulkan-dev glslc spirv-headers \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp /src
# One build for every x86 CPU (the best variant is picked at start-up). Vulkan only on amd64:
# arm64 boards rarely have a GPU Vulkan can use, and it would be slow to build under emulation.
RUN set -eux; \
    if [ "$TARGETARCH" = amd64 ]; then extra="-DGGML_VULKAN=ON -DGGML_CPU_ALL_VARIANTS=ON"; else extra=""; fi; \
    cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF $extra; \
    cmake --build /build -j"$(nproc)" --target whisper-cli; \
    mkdir /out; cp -P /build/bin/whisper-cli /build/bin/*.so* /out/

# ---------- whisper.cpp: CPU + CUDA ----------
# CUDA 12: CUDA 13 dropped the GTX 10 series (Pascal), which is still common in home servers.
FROM nvidia/cuda:12.9.1-devel-ubuntu24.04 AS whisper-cuda
ARG WHISPER_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_VERSION" https://github.com/ggml-org/whisper.cpp /src
# GPU generations: 52 GTX 900, 61 GTX 10, 75 GTX 16 / RTX 20, 86 RTX 30, 89 RTX 40 (+ PTX, so
# newer cards compile it on first use). NCCL off: it only helps with several GPUs, and the devel
# image would link it without it being in the final image, so the CUDA backend couldn't load.
RUN set -eux; \
    cmake -S /src -B /build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF \
      -DGGML_CPU_ALL_VARIANTS=ON -DGGML_CUDA=ON -DGGML_CUDA_NCCL=OFF -DCMAKE_CUDA_ARCHITECTURES="52-real;61-real;75-real;86-real;89" \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_SDL2=OFF; \
    cmake --build /build -j"$(nproc)" --target whisper-cli; \
    mkdir /out; cp -P /build/bin/whisper-cli /build/bin/*.so* /out/; \
    # The CUDA runtime libraries the backend needs; the driver (libcuda) comes from the host.
    ldd /out/libggml-cuda.so | grep -o '/usr/local/cuda[^ ]*' | xargs -r cp -L -t /out/

FROM whisper-${GPU} AS whisper

# ---------- the app ----------
FROM node:24-trixie-slim AS app
ARG GPU
ARG TARGETARCH
ARG WHISPER_VERSION
RUN set -eux; apt-get update; \
    apt-get install -y --no-install-recommends ffmpeg tzdata libgomp1 util-linux; \
    if [ "$GPU" = vulkan ] && [ "$TARGETARCH" = amd64 ]; then \
      apt-get install -y --no-install-recommends libvulkan1 mesa-vulkan-drivers; \
      # Mesa's software renderer is slower than whisper's own CPU code: never offer it.
      rm -f /usr/share/vulkan/icd.d/lvp_icd*.json; \
    fi; \
    rm -rf /var/lib/apt/lists/*

COPY --from=whisper /out/ /opt/whisper/

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=6162 \
    PUID=99 \
    PGID=100 \
    UMASK=002 \
    TZ=Etc/UTC \
    WHISPER_BIN=/opt/whisper/whisper-cli \
    LD_LIBRARY_PATH=/opt/whisper \
    WHISPER_VERSION=${WHISPER_VERSION} \
    DUALARR_GPU=${GPU}

EXPOSE 6162
VOLUME /config

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

LABEL org.opencontainers.image.title="Dualarr" \
      org.opencontainers.image.description="Keeps anime in Sonarr in Japanese with subtitles, and swaps subbed releases for dual audio when the dub comes out" \
      org.opencontainers.image.source="https://github.com/jpjoseph12/dualarr" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]

# The NVIDIA container runtime reads these; without --runtime=nvidia they do nothing.
FROM app AS app-cuda
ENV NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

FROM app AS app-vulkan

FROM app-${GPU}
