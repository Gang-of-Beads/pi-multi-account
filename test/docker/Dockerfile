# Isolated pi for the codex-accounts store-watch regression.
# The staging directory (see run.sh) supplies home/ and plugins/, so a run never reads
# the host's store, settings or extension set.
FROM node:22-bookworm
RUN npm i -g @earendil-works/pi-coding-agent@1.1.0 && pi --version
ENV HOME=/home/pitest
COPY home/ /home/pitest/
COPY plugins/ /opt/plugins/
RUN chmod +x /opt/plugins/entrypoint.sh
WORKDIR /home/pitest
ENTRYPOINT ["/bin/bash", "/opt/plugins/entrypoint.sh"]
