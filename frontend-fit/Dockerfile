# Собирается из корня репозитория (context: .), чтобы был доступен общий design/tokens.css
FROM node:22-alpine AS build
WORKDIR /app/frontend-fit
COPY frontend-fit/package.json frontend-fit/package-lock.json ./
RUN npm ci
COPY design /app/design
COPY frontend-fit/ .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/frontend-fit/dist /usr/share/nginx/html
COPY frontend-fit/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
