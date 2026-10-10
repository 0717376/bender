# Собирается из корня репозитория (context: .), чтобы был доступен общий design/tokens.css
FROM node:22-alpine AS build
WORKDIR /app/frontend-cards
COPY frontend-cards/package.json frontend-cards/package-lock.json ./
RUN npm ci
COPY design /app/design
COPY frontend-cards/ .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/frontend-cards/dist /usr/share/nginx/html
COPY frontend-cards/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
