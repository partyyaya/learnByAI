FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY index.html ./index.html
COPY main.js ./main.js

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
