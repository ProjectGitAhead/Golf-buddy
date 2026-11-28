# Serves the prebuilt hosted copy (dist/site) with nginx on port 8080, plus the /api/osm map lookup (plan 16.2).
FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
# A bad config stops the deploy here instead of breaking the site. `nginx -t` opens the listen sockets, and a build
# machine may have no IPv6, so a copy without the IPv6 listen line is tested (the image keeps both lines). The grep
# makes sure the copy really replaces the stock include, so the test can't pass without reading our file.
RUN grep -q 'include /etc/nginx/conf.d/\*.conf;' /etc/nginx/nginx.conf \
 && sed '/listen \[::\]:8080;/d' /etc/nginx/conf.d/default.conf > /tmp/site-v4.conf \
 && sed 's#include /etc/nginx/conf.d/\*.conf;#include /tmp/site-v4.conf;#' /etc/nginx/nginx.conf > /tmp/nginx-test.conf \
 && grep -q 'include /tmp/site-v4.conf;' /tmp/nginx-test.conf \
 && nginx -t -c /tmp/nginx-test.conf \
 && rm /tmp/site-v4.conf /tmp/nginx-test.conf
COPY dist/site /usr/share/nginx/html
EXPOSE 8080
