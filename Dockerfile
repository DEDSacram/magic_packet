FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV HOST=127.0.0.1
ENV PORT=8080

USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
