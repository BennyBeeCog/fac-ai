FROM node:22-slim

WORKDIR /app

COPY package.json .
RUN npm install --omit=dev

COPY index.mjs .

CMD ["node", "index.mjs"]
