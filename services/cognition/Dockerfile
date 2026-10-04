FROM node:22-slim
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PORT=8890
EXPOSE 8890

CMD ["sh", "-c", "node src/db/migrate.js && node src/server.js"]
