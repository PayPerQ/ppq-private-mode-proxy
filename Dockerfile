FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ENV HOST=0.0.0.0
ENV PORT=8787

EXPOSE 8787

CMD ["npx", "tsx", "bin/server.ts"]
