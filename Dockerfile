# Serves the prebuilt hosted copy (dist/site) with nginx on port 8080, plus the /api/osm map lookup (plan 16.2).
FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# A bad config stops the deploy here instead of breaking the site.
RUN nginx -t
COPY dist/site /usr/share/nginx/html
EXPOSE 8080
