FROM --platform=$BUILDPLATFORM oven/bun AS builder
WORKDIR /app

# https://github.com/oven-sh/bun/issues/24538
# Remember to also remove `tsx` after this bug is fixed
RUN apt update && apt install -y nodejs && rm /usr/local/bun-node-fallback-bin/node

ENV NODE_ENV=production
COPY package.json bun.lock .
COPY patches patches
COPY scripts scripts
COPY public public
RUN bun install --production

COPY . .
RUN bun web

# TODO: replace this nginx with a SSR enabled server.
FROM nginx
EXPOSE 8901
COPY <<EOF /etc/nginx/conf.d/default.conf
server {
  listen 8901;
  charset utf-8;

  root /usr/share/nginx/html;
  index index.html;

  # jassub's wasm is multithreaded (SharedArrayBuffer) and needs the page to be
  # cross-origin isolated. `credentialless` keeps cross-origin video/subtitle
  # requests working without CORP headers on every remote asset.
  add_header Cross-Origin-Opener-Policy same-origin;
  add_header Cross-Origin-Embedder-Policy credentialless;

  location = /index.html {
    add_header Cross-Origin-Opener-Policy same-origin;
    add_header Cross-Origin-Embedder-Policy credentialless;
    add_header Cache-Control "no-cache";
  }

  location ~ "^/(_expo/static/(css/.+-[0-9a-f]{32}\.css|js/web/.+-[0-9a-f]{32}\.js)|assets/.+\.[0-9a-f]{32}(@[0-9]+(\.[0-9]+)?x)?\.[a-zA-Z0-9]+)$" {
    try_files \$uri =404;
    add_header Cross-Origin-Opener-Policy same-origin;
    add_header Cross-Origin-Embedder-Policy credentialless;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location / {
    try_files \$uri \$uri/ /index.html;
  }
}
EOF

COPY --from=builder /app/dist /usr/share/nginx/html
