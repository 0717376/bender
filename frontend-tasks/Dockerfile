# Собирается из корня репозитория (context: .), чтобы был доступен общий design/tokens.css
FROM node:22-alpine AS build
WORKDIR /app/frontend-tasks
COPY frontend-tasks/package.json frontend-tasks/package-lock.json ./
RUN npm ci
COPY design /app/design
COPY frontend-tasks/ .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/frontend-tasks/dist /usr/share/nginx/html
COPY frontend-tasks/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
