# Собирается из корня репозитория (context: .), чтобы был доступен общий design/tokens.css
FROM node:22-alpine AS build
WORKDIR /app/frontend-books
COPY frontend-books/package.json frontend-books/package-lock.json ./
# Playwright нужен только тестам на машине разработчика — браузеры в образ не тянем.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci
COPY design /app/design
COPY frontend-books/ .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/frontend-books/dist /usr/share/nginx/html
COPY frontend-books/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
