FROM node:20-alpine

RUN apk add --no-cache python3 make g++ tzdata

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

RUN mkdir -p /app/data

CMD ["node", "index.js"]