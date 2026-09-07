#!/bin/sh
# Deploy/atualizacao da API de bug reports (rodar dentro de api/, no servidor).
set -eu

cd "$(dirname "$0")/.."

fail() {
    echo "ERRO: $1" >&2
    exit 1
}

command -v docker >/dev/null 2>&1 || fail "docker nao encontrado no PATH"
docker compose version >/dev/null 2>&1 || fail "plugin 'docker compose' nao disponivel"

[ -f .env ] || fail ".env ausente em $(pwd) - copie de .env.example"
chmod 600 .env

for var in API_TOKEN GITHUB_TOKEN GITHUB_WEBHOOK_SECRET; do
    if ! grep -Eq "^${var}=..+" .env; then
        fail "${var} vazio ou ausente no .env"
    fi
done

echo "==> build da imagem"
docker compose build --pull

echo "==> subindo container"
docker compose up -d

echo "==> aguardando healthz em 127.0.0.1:8091"
base_path="$(sed -n 's/^BASE_PATH=//p' .env | head -1 | sed 's#^[/[:space:]]*##; s#[/[:space:]]*$##')"
i=0
until curl -fsS "http://127.0.0.1:8091/${base_path}/healthz" >/dev/null 2>&1; do
    i=$((i + 2))
    [ "$i" -ge 30 ] && {
        docker compose logs --tail=50
        fail "healthz nao respondeu em ate 30s"
    }
    sleep 2
done
echo "==> healthz OK"

docker compose ps
echo "==> deploy concluido. Logs: docker compose logs -f"
