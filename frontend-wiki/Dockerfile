# Собирается из корня репозитория (context: .), чтобы был доступен общий design/tokens.css
FROM node:20-alpine AS build
WORKDIR /app/frontend-wiki
COPY frontend-wiki/package.json ./
RUN npm install
COPY design /app/design
COPY frontend-wiki/ .
RUN npm run build

FROM nginx:alpine
COPY frontend-wiki/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend-wiki/dist /usr/share/nginx/html
