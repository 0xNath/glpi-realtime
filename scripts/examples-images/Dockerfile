# The images scripts/check-examples.sh runs the examples of deploy/ through, one stage
# each (the stage name is how the script refers to it). Not built: written as a
# Dockerfile so that Dependabot proposes their new versions.
FROM docker.io/library/nginx:1.31.8 AS nginx
FROM docker.io/library/httpd:2.4.70 AS httpd
FROM docker.io/library/caddy:2.11.8 AS caddy
FROM docker.io/valkey/valkey:9.0 AS valkey
FROM docker.io/prom/prometheus:v3.5.0 AS prometheus
