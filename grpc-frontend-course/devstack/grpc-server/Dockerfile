FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY ping.proto ./ping.proto
COPY server.js ./server.js

EXPOSE 50051

CMD ["npm", "start"]
