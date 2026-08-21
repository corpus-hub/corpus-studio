# Build a FULLY STATIC qpdf for linux-x64, from source, for shipping in the
# installer. Consumed by `npm run payloads` (scripts/payloads.ts).
#
# Why build instead of using the upstream binary release: the upstream
# `qpdf-<v>-bin-linux-x86_64.zip` ships a private gnutls/nettle/p11-kit/idn2
# TLS stack alongside the executable (verified: `lib/libgnutls.so.30` and
# friends are in the zip and `ldd` resolves to them). Bundling that would mean
# signing, notarizing and patching CVEs for a whole TLS implementation, in an
# app whose entire premise is that it never opens a socket. The static build
# links libc/libstdc++ only and is ~4 MB.
#
# Why Alpine/musl: a fully static glibc binary is not supportable (glibc's NSS
# still dlopens at runtime), whereas musl links completely statically and the
# result runs on ANY linux-x64 host regardless of its libc. Nothing here needs
# NSS — qpdf resolves no names and opens no sockets.
#
# The base image is pinned BY DIGEST, not by tag: `alpine:3.21` is a moving
# target that is rebuilt for every CVE patch, so a tag pin would silently
# change the toolchain — and therefore the output binary — under a manifest
# that claims to record exactly what shipped.
FROM alpine@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

RUN apk add --no-cache build-base cmake zlib-dev zlib-static libjpeg-turbo-dev libjpeg-turbo-static perl

ARG QPDF_VERSION
ARG QPDF_SHA256

WORKDIR /src
# The tarball is COPYied in, never downloaded here: the fetch and its
# hash check happen in scripts/payloads.ts, against the manifest, on the host.
# A `curl` in this layer would be an unverified network fetch inside the build
# and would make the Dockerfile a second, competing provenance mechanism.
COPY qpdf-src.tar.gz /src/qpdf-src.tar.gz
RUN echo "${QPDF_SHA256}  /src/qpdf-src.tar.gz" | sha256sum -c - \
 && tar xzf qpdf-src.tar.gz \
 && mv "qpdf-${QPDF_VERSION}" qpdf

WORKDIR /src/qpdf
# crypto=native: qpdf's own AES/RC4/SHA2 implementation, so neither gnutls nor
# openssl is linked. REQUIRE_CRYPTO_NATIVE makes a missing native provider a
# configure-time failure rather than a silent fallback to a TLS library.
RUN cmake -S . -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF \
      -DUSE_IMPLICIT_CRYPTO=OFF \
      -DREQUIRE_CRYPTO_NATIVE=ON \
      -DBUILD_DOC=OFF \
      -DBUILD_DOC_PDF=OFF \
      -DQTEST_COLOR=OFF \
      -DCMAKE_EXE_LINKER_FLAGS="-static -static-libgcc -static-libstdc++" \
 && cmake --build build -j"$(nproc)" --target qpdf \
 && strip build/qpdf/qpdf

# Fail the image build, not the packaging run, if the result is not actually
# static or has somehow acquired a network symbol.
RUN file build/qpdf/qpdf | grep -q 'statically linked' \
 && ! (nm -D build/qpdf/qpdf 2>/dev/null | grep -qiE 'connect|socket|getaddrinfo') \
 && build/qpdf/qpdf --version

CMD ["cat", "/src/qpdf/build/qpdf/qpdf"]

# THE EXPORT STAGE, and the only thing `npm run payloads` reads from this build.
# `scratch` holds exactly one file, so `buildx --output type=local` writes that
# file and nothing else.
#
# It exists because the older way out -- tag the image, `docker create` it,
# `docker cp` the binary -- needs the tag to be visible in the daemon's image
# list, and on a daemon using the containerd snapshotter it is not: the build
# reports "naming to ... unpacking to ... DONE" while `docker images` shows
# nothing, so the create fails and then tries to PULL a tag that never left the
# machine. A file export depends on none of that.
FROM scratch AS export
COPY --from=0 /src/qpdf/build/qpdf/qpdf /qpdf
