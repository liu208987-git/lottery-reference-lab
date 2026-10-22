#!/bin/sh
set -eu

PROGRAM=lottery-lab
REPOSITORY=${LOTTERY_REPOSITORY:-Coco422/lottery-model-lab}
IMAGE_REPOSITORY=${LOTTERY_IMAGE_REPOSITORY:-ghcr.io/coco422/lottery-model-lab}
CHANNEL=${LOTTERY_CHANNEL:-latest}
INSTALL_ROOT=${LOTTERY_INSTALL_ROOT:-/opt/lottery-model-lab}
PROJECT_NAME=${LOTTERY_PROJECT_NAME:-lottery-model-lab}
MANAGER_PATH=${LOTTERY_MANAGER_PATH:-/usr/local/bin/lottery-lab}
HEALTH_TIMEOUT=${LOTTERY_HEALTH_TIMEOUT:-90}
REQUIRE_SIGNATURE=${LOTTERY_REQUIRE_SIGNATURE:-0}

LOCK_DIR=
STAGING_DIR=

log() {
    printf '%s: %s\n' "$PROGRAM" "$*"
}

warn() {
    printf '%s: warning: %s\n' "$PROGRAM" "$*" >&2
}

fatal() {
    printf '%s: error: %s\n' "$PROGRAM" "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: install.sh <command>

Commands:
  install    Install the latest healthy public image
  update     Resolve latest to an immutable digest and perform a safe update
  rollback   Restore the previously healthy image and Compose release
  status     Show the active release and Compose service status
  logs       Show the latest 200 application log lines (extra args are passed on)

Environment overrides:
  LOTTERY_REPOSITORY             GitHub owner/repository
  LOTTERY_IMAGE_REPOSITORY       GHCR image repository
  LOTTERY_CHANNEL                Source image tag, default: latest
  LOTTERY_INSTALL_ROOT           Installation root, default: /opt/lottery-model-lab
  LOTTERY_MANAGER_PATH           Installed command, default: /usr/local/bin/lottery-lab
  LOTTERY_BIND_ADDRESS           Published bind address, default: 127.0.0.1
  LOTTERY_PORT                   Published port, default: 8765
  LOTTERY_ALLOWED_ORIGINS        Comma-separated browser origin allowlist
  LOTTERY_REQUIRE_SIGNATURE=1    Fail unless cosign is installed and verifies
EOF
}

cleanup() {
    if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
        rm -rf "$STAGING_DIR"
    fi
    if [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
}

trap cleanup EXIT HUP INT TERM

need_command() {
    command -v "$1" >/dev/null 2>&1 || fatal "required command is missing: $1"
}

check_docker_dependencies() {
    need_command docker
    docker compose version >/dev/null 2>&1 \
        || fatal "Docker Compose v2 plugin is required"
}

check_deploy_dependencies() {
    need_command curl
    check_docker_dependencies
}

acquire_lock() {
    mkdir -p "$INSTALL_ROOT"
    LOCK_DIR=$INSTALL_ROOT/.deployment-lock
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        fatal "another install, update, or rollback is already running"
    fi
}

secure_download() {
    url=$1
    destination=$2
    curl \
        --fail \
        --silent \
        --show-error \
        --location \
        --proto '=https' \
        --tlsv1.2 \
        --retry 4 \
        --retry-delay 2 \
        --connect-timeout 10 \
        --max-time 60 \
        --output "$destination" \
        "$url"
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        fatal "sha256sum or shasum is required"
    fi
}

read_env_value() {
    file=$1
    key=$2
    fallback=$3
    value=
    if [ -f "$file" ]; then
        value=$(sed -n "s/^${key}=//p" "$file" | tail -n 1)
        case "$value" in
            \'*\') value=$(printf '%s' "$value" | sed "s/^'//;s/'$//") ;;
        esac
    fi
    if [ -n "$value" ]; then
        printf '%s' "$value"
    else
        printf '%s' "$fallback"
    fi
}

resolve_release_link() {
    link_name=$1
    link_path=$INSTALL_ROOT/$link_name
    [ -L "$link_path" ] || return 1
    target=$(readlink "$link_path")
    case "$target" in
        /*) printf '%s\n' "$target" ;;
        *) printf '%s/%s\n' "$INSTALL_ROOT" "$target" ;;
    esac
}

atomic_release_link() {
    link_name=$1
    link_release_path=$2
    relative=${link_release_path#"$INSTALL_ROOT"/}
    temporary=$INSTALL_ROOT/.${link_name}.$$
    rm -f "$temporary"
    ln -s "$relative" "$temporary"
    mv -Tf "$temporary" "$INSTALL_ROOT/$link_name"
}

compose_for() {
    compose_release_path=$1
    shift
    docker compose \
        --project-name "$PROJECT_NAME" \
        --env-file "$compose_release_path/.env" \
        --file "$compose_release_path/compose.yaml" \
        "$@"
}

validate_repository_settings() {
    case "$INSTALL_ROOT" in
        /*) ;;
        *) fatal "LOTTERY_INSTALL_ROOT must be an absolute path" ;;
    esac
    case "$MANAGER_PATH" in
        /*) ;;
        *) fatal "LOTTERY_MANAGER_PATH must be an absolute path" ;;
    esac
    printf '%s' "$REPOSITORY" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' \
        || fatal "invalid LOTTERY_REPOSITORY: $REPOSITORY"
    printf '%s' "$IMAGE_REPOSITORY" | grep -Eq '^ghcr\.io/[a-z0-9_.-]+/[a-z0-9_./-]+$' \
        || fatal "invalid lowercase GHCR repository: $IMAGE_REPOSITORY"
    printf '%s' "$CHANNEL" | grep -Eq '^[A-Za-z0-9_.-]+$' \
        || fatal "invalid image channel: $CHANNEL"
    printf '%s' "$HEALTH_TIMEOUT" | grep -Eq '^[0-9]+$' \
        || fatal "LOTTERY_HEALTH_TIMEOUT must be an integer"
    case "$REQUIRE_SIGNATURE" in
        0 | 1) ;;
        *) fatal "LOTTERY_REQUIRE_SIGNATURE must be 0 or 1" ;;
    esac
}

verify_signature() {
    image_ref=$1
    if command -v cosign >/dev/null 2>&1; then
        identity="^https://github.com/${REPOSITORY}/.github/workflows/container\\.yml@refs/(heads/main|tags/v[0-9].*)$"
        log "verifying GitHub Actions keyless image signature"
        cosign verify \
            --certificate-oidc-issuer https://token.actions.githubusercontent.com \
            --certificate-identity-regexp "$identity" \
            "$image_ref" >/dev/null
    elif [ "$REQUIRE_SIGNATURE" = 1 ]; then
        fatal "LOTTERY_REQUIRE_SIGNATURE=1 but cosign is not installed"
    else
        warn "cosign is not installed; digest and Compose hash checks remain active"
    fi
}

resolved_image_metadata() {
    source_ref=$IMAGE_REPOSITORY:$CHANNEL
    log "pulling $source_ref"
    pull_attempt=1
    while ! docker pull "$source_ref"; do
        if [ "$pull_attempt" -ge 5 ]; then
            fatal "could not pull $source_ref after $pull_attempt attempts"
        fi
        warn "image pull failed; retrying in $((pull_attempt * 2)) seconds"
        sleep $((pull_attempt * 2))
        pull_attempt=$((pull_attempt + 1))
    done

    digest_ref=$(docker image inspect \
        --format '{{range .RepoDigests}}{{println .}}{{end}}' \
        "$source_ref" \
        | awk -v prefix="$IMAGE_REPOSITORY@" 'index($0, prefix) == 1 {print; exit}')
    [ -n "$digest_ref" ] || fatal "could not resolve an immutable image digest"
    printf '%s' "$digest_ref" | grep -Eq '@sha256:[a-f0-9]{64}$' \
        || fatal "registry returned an invalid image digest: $digest_ref"

    revision=$(docker image inspect \
        --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
        "$source_ref")
    printf '%s' "$revision" | grep -Eq '^[a-f0-9]{40}$' \
        || fatal "image does not contain a full Git revision label"

    compose_sha=$(docker image inspect \
        --format '{{index .Config.Labels "io.lottery-lab.compose-sha256"}}' \
        "$source_ref")
    printf '%s' "$compose_sha" | grep -Eq '^[a-f0-9]{64}$' \
        || fatal "image does not contain a valid Compose SHA-256 label"

    RESOLVED_IMAGE=$digest_ref
    RESOLVED_REVISION=$revision
    RESOLVED_COMPOSE_SHA=$compose_sha
}

write_release_env() {
    destination=$1
    previous_env=$2

    default_bind=$(read_env_value "$previous_env" LOTTERY_BIND_ADDRESS 127.0.0.1)
    default_port=$(read_env_value "$previous_env" LOTTERY_PORT 8765)
    default_origins=$(read_env_value "$previous_env" LOTTERY_ALLOWED_ORIGINS '')
    default_days=$(read_env_value "$previous_env" LOTTERY_PUBLIC_MAX_FUTURE_DAYS 366)
    default_memory=$(read_env_value "$previous_env" LOTTERY_MEMORY_LIMIT 1g)
    default_cpu=$(read_env_value "$previous_env" LOTTERY_CPU_LIMIT 2.0)

    bind_address=${LOTTERY_BIND_ADDRESS:-$default_bind}
    port=${LOTTERY_PORT:-$default_port}
    allowed_origins=${LOTTERY_ALLOWED_ORIGINS:-$default_origins}
    future_days=${LOTTERY_PUBLIC_MAX_FUTURE_DAYS:-$default_days}
    memory_limit=${LOTTERY_MEMORY_LIMIT:-$default_memory}
    cpu_limit=${LOTTERY_CPU_LIMIT:-$default_cpu}

    printf '%s' "$bind_address" \
        | grep -Eq '^([A-Za-z0-9_.:-]+|\[[0-9A-Fa-f:]+\])$' \
        || fatal "invalid LOTTERY_BIND_ADDRESS"
    printf '%s' "$port" | grep -Eq '^[0-9]+$' \
        || fatal "LOTTERY_PORT must be an integer"
    if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        fatal "LOTTERY_PORT must be between 1 and 65535"
    fi
    printf '%s' "$future_days" | grep -Eq '^[0-9]+$' \
        || fatal "LOTTERY_PUBLIC_MAX_FUTURE_DAYS must be an integer"
    printf '%s' "$memory_limit" | grep -Eq '^[0-9]+[bkmgBKMG]?$' \
        || fatal "invalid LOTTERY_MEMORY_LIMIT"
    printf '%s' "$cpu_limit" | grep -Eq '^[0-9]+([.][0-9]+)?$' \
        || fatal "invalid LOTTERY_CPU_LIMIT"
    case "$allowed_origins" in
        *"'"* | *"
"*) fatal "LOTTERY_ALLOWED_ORIGINS contains an unsupported character" ;;
    esac

    cat >"$destination" <<EOF
LOTTERY_IMAGE=$RESOLVED_IMAGE
LOTTERY_BIND_ADDRESS=$bind_address
LOTTERY_PORT=$port
LOTTERY_ALLOWED_ORIGINS='$allowed_origins'
LOTTERY_PUBLIC_MAX_FUTURE_DAYS=$future_days
LOTTERY_MEMORY_LIMIT=$memory_limit
LOTTERY_CPU_LIMIT=$cpu_limit
EOF
    chmod 0600 "$destination"
}

wait_for_health() {
    health_release_path=$1
    deadline=$(($(date +%s) + HEALTH_TIMEOUT))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        container_id=$(compose_for "$health_release_path" ps -q app 2>/dev/null || true)
        if [ -n "$container_id" ]; then
            state=$(docker inspect \
                --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
                "$container_id" 2>/dev/null || true)
            case "$state" in
                healthy) return 0 ;;
                unhealthy | exited | dead) return 1 ;;
            esac
        fi
        sleep 2
    done
    return 1
}

start_release() {
    start_release_path=$1
    compose_for "$start_release_path" config --quiet
    compose_for "$start_release_path" up --detach --remove-orphans
    wait_for_health "$start_release_path"
}

install_manager_copy() {
    manager_release_path=$1
    manager_dir=$(dirname "$MANAGER_PATH")
    mkdir -p "$manager_dir"
    temporary_manager=$(mktemp "$manager_dir/.lottery-lab.XXXXXX")
    cp "$manager_release_path/install.sh" "$temporary_manager"
    chmod 0755 "$temporary_manager"
    mv -f "$temporary_manager" "$MANAGER_PATH"
}

deploy_latest() {
    check_deploy_dependencies
    validate_repository_settings
    acquire_lock
    mkdir -p "$INSTALL_ROOT/releases"

    old_release=$(resolve_release_link current 2>/dev/null || true)
    old_env=
    if [ -n "$old_release" ]; then
        old_env=$old_release/.env
    fi

    resolved_image_metadata
    verify_signature "$RESOLVED_IMAGE"

    digest_hex=${RESOLVED_IMAGE##*@sha256:}
    short_digest=$(printf '%s' "$digest_hex" | cut -c 1-12)
    release_id=${RESOLVED_REVISION}-${short_digest}-$(date -u +%Y%m%d%H%M%S)
    release_path=$INSTALL_ROOT/releases/$release_id
    STAGING_DIR=$(mktemp -d "$INSTALL_ROOT/releases/.staging.XXXXXX")

    raw_base=https://raw.githubusercontent.com/$REPOSITORY/$RESOLVED_REVISION
    secure_download "$raw_base/compose.yaml" "$STAGING_DIR/compose.yaml"
    actual_compose_sha=$(sha256_file "$STAGING_DIR/compose.yaml")
    [ "$actual_compose_sha" = "$RESOLVED_COMPOSE_SHA" ] \
        || fatal "downloaded Compose file does not match the image label"
    secure_download "$raw_base/deploy/install.sh" "$STAGING_DIR/install.sh"
    chmod 0755 "$STAGING_DIR/install.sh"
    write_release_env "$STAGING_DIR/.env" "$old_env"

    cat >"$STAGING_DIR/release.env" <<EOF
LOTTERY_RELEASE_REVISION=$RESOLVED_REVISION
LOTTERY_RELEASE_IMAGE=$RESOLVED_IMAGE
LOTTERY_RELEASE_COMPOSE_SHA256=$RESOLVED_COMPOSE_SHA
LOTTERY_RELEASE_CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    chmod 0600 "$STAGING_DIR/release.env"

    compose_for "$STAGING_DIR" config --quiet
    mv "$STAGING_DIR" "$release_path"
    STAGING_DIR=

    log "starting revision $RESOLVED_REVISION at immutable digest $short_digest"
    if ! start_release "$release_path"; then
        compose_for "$release_path" logs --tail=100 app >&2 || true
        if [ -n "$old_release" ] && [ -d "$old_release" ]; then
            warn "new release failed health checks; restoring the previous release"
            if ! start_release "$old_release"; then
                fatal "automatic rollback also failed; inspect Docker logs immediately"
            fi
        else
            compose_for "$release_path" down --remove-orphans >/dev/null 2>&1 || true
        fi
        fatal "deployment failed its health check"
    fi

    if [ -n "$old_release" ] && [ -d "$old_release" ]; then
        atomic_release_link previous "$old_release"
    fi
    atomic_release_link current "$release_path"
    install_manager_copy "$release_path"

    log "deployment is healthy"
    log "active revision: $RESOLVED_REVISION"
    log "active image: $RESOLVED_IMAGE"
    log "local endpoint: http://$(read_env_value "$release_path/.env" LOTTERY_BIND_ADDRESS 127.0.0.1):$(read_env_value "$release_path/.env" LOTTERY_PORT 8765)"
    log "manager command: $MANAGER_PATH"
}

rollback_release() {
    check_docker_dependencies
    acquire_lock
    current_release=$(resolve_release_link current 2>/dev/null || true)
    previous_release=$(resolve_release_link previous 2>/dev/null || true)
    if [ -z "$current_release" ] || [ ! -d "$current_release" ]; then
        fatal "there is no active release"
    fi
    if [ -z "$previous_release" ] || [ ! -d "$previous_release" ]; then
        fatal "there is no previous release to restore"
    fi

    log "restoring $(basename "$previous_release")"
    if ! start_release "$previous_release"; then
        compose_for "$previous_release" logs --tail=100 app >&2 || true
        warn "rollback target failed; restarting the current release"
        start_release "$current_release" \
            || fatal "both rollback and current releases failed health checks"
        fatal "rollback target was unhealthy"
    fi

    atomic_release_link current "$previous_release"
    atomic_release_link previous "$current_release"
    install_manager_copy "$previous_release"
    log "rollback completed"
}

show_status() {
    check_docker_dependencies
    current_release=$(resolve_release_link current 2>/dev/null || true)
    if [ -z "$current_release" ] || [ ! -d "$current_release" ]; then
        fatal "Lottery Model Lab is not installed"
    fi
    if [ -f "$current_release/release.env" ]; then
        cat "$current_release/release.env"
    fi
    compose_for "$current_release" ps
}

show_logs() {
    check_docker_dependencies
    current_release=$(resolve_release_link current 2>/dev/null || true)
    if [ -z "$current_release" ] || [ ! -d "$current_release" ]; then
        fatal "Lottery Model Lab is not installed"
    fi
    shift
    compose_for "$current_release" logs --tail=200 "$@" app
}

command_name=${1:-}
case "$command_name" in
    install | update)
        deploy_latest
        ;;
    rollback)
        rollback_release
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs "$@"
        ;;
    -h | --help | help | '')
        usage
        ;;
    *)
        usage >&2
        fatal "unknown command: $command_name"
        ;;
esac
