# MarketLens desktop/web edition as a container. No dependencies beyond Python.
FROM python:3.12-slim AS build
WORKDIR /src
COPY pyproject.toml MANIFEST.in LICENSE README.md ./
COPY src ./src
RUN pip install --no-cache-dir build==1.2.2 && python -m build --wheel --outdir /wheels

FROM python:3.12-slim
LABEL org.opencontainers.image.source="https://github.com/akash-8991/rea_marketwatch_app" \
      org.opencontainers.image.description="MarketLens: local NSE markets dashboard" \
      org.opencontainers.image.licenses="MIT"
RUN useradd --create-home --uid 10001 marketlens && mkdir /data && chown marketlens /data
COPY --from=build /wheels/*.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm /tmp/*.whl
USER marketlens
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8080/healthz', timeout=4)"
# Binding 0.0.0.0 is needed inside a container; publish the port on 127.0.0.1 only (see docker-compose.yml).
ENTRYPOINT ["marketlens", "--host", "0.0.0.0", "--port", "8080", "--data-dir", "/data", "--no-open"]
