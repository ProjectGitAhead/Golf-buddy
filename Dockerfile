# Serves the prebuilt hosted copy (dist/site) with nginx on port 8080.
FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY dist/site /usr/share/nginx/html
EXPOSE 8080
