#!/usr/bin/env sh

print_message() {
    echo " ️  $1"
}

print_success() {
    echo "✅ $1"
}

print_error() {
    echo "❌ $1"
}

print_question() {
    echo "ℹ️ $1"
}

update_or_add_env_var() {
    KEY=$1
    VALUE=$2

    # Check if the key already exists in the .env file
    if grep -q "^$KEY=" .env; then
        # Key exists, update its value
        sed -i '' "s/^$KEY=.*/$KEY=$VALUE/" .env
    else
        # Key doesn't exist, add it
        echo "$KEY=$VALUE" >> .env
    fi
}

# Welcome Prompt
print_message "👋 Welcome to the AR.IO Network Setup Script!"
echo ""
print_message "This script will guide you through the process of configuring your AR.IO node."
print_message "You'll be prompted to choose which services you want to run and to set various configuration options."
print_message "By the end of this setup, your AR.IO node will be configured and running, ready to participate in the AR.IO network."
print_message "We’re excited to have you join the AR.IO community and help grow the decentralized web! 🚀"
print_message "Let's get started! ⏳"
echo ""

# Step 1: Identify the Operating System
OS="$(uname -s)"
case "$OS" in
    Linux*)     OS_TYPE=Linux;;
    Darwin*)    OS_TYPE=Mac;;
    *)          OS_TYPE="UNKNOWN"
esac

if [ "$OS_TYPE" = "UNKNOWN" ]; then
    print_error "Unsupported operating system detected. This script only supports Linux and MacOS. 🚫"
    exit 1
fi

# Step 2: Check for Docker and Docker Compose v2
print_message "Checking if required tools are installed 🔍"
DOCKER_CHECK=$(command -v docker)
DOCKER_COMPOSE_VERSION=$(docker compose version 2>/dev/null | grep "Docker Compose version v2")

if [ -z "$DOCKER_CHECK" ] || [ -z "$DOCKER_COMPOSE_VERSION" ]; then
    print_error "It seems Docker or Docker Compose v2 is not installed, or you may not have the required permissions to run Docker. 😢"
    echo "👉 Please check if Docker is installed and you have the correct permissions. If not, you can find installation instructions on the Docker website:"
    if [ "$OS_TYPE" = "Mac" ]; then
        echo "🍏 https://docs.docker.com/desktop/install/mac-install/"
    elif [ "$OS_TYPE" = "Linux" ]; then
        echo "🐧 https://docs.docker.com/desktop/install/linux-install/"
    fi
    exit 1
else
    print_success "Docker and Docker Compose v2 are installed 🎉"
fi

# Step 3: Download the Docker Compose file and .env from the latest tag
LATEST_TAG=$(curl -s https://api.github.com/repos/ar-io/ar-io-node/tags | grep 'name' | head -n 1 | cut -d\" -f4)

if [ -z "$LATEST_TAG" ]; then
    print_error "Failed to retrieve the latest release tag. Please check your internet connection or the repository status."
    exit 1
fi

# Define the URLs for the files to download
DOCKER_COMPOSE_URL="https://raw.githubusercontent.com/ar-io/ar-io-node/$LATEST_TAG/docker-compose.yaml"
ENV_EXAMPLE_URL="https://raw.githubusercontent.com/ar-io/ar-io-node/$LATEST_TAG/.env.example"

curl -s -O "$DOCKER_COMPOSE_URL"
if [ $? -ne 0 ]; then
    print_error "Failed to download docker-compose.yaml. Please try again. 💻"
    exit 1
fi

curl -s -O "$ENV_EXAMPLE_URL"
if [ $? -ne 0 ]; then
    print_error "Failed to download .env.example. Please try again. 💻"
    exit 1
else
    mv .env.example .env
fi

# Delete existing docker-compose.override.yml if it exists
if [ -f docker-compose.override.yml ]; then
    rm docker-compose.override.yml
fi

# Step 4: Prompt the user to select services to run
echo "";
echo "";
print_message "The AR.IO node setup includes several services. You can choose which services you'd like to run:"

echo "1) Envoy - A reverse proxy that handles incoming requests"
echo "2) Node - The AR.IO gateway (called core in docker compose) + Redis"
echo "3) Observer - Creates observation reports based on ArNS name requests to other AR.IO gateways"
echo "4) Resolver - Resolves ArNS names that your node will respond to"
echo "5) Litestream - Provides continuous backup for SQLite databases"

echo ""
print_message "Please enter the numbers corresponding to the services you'd like to run (e.g., 1 2 3):"
read -r SERVICES_SELECTED
echo ""

# Build a list of services to disable using profiles
SERVICES_TO_DISABLE=""
for SERVICE in 1 2 3 4 5; do
    if ! echo "$SERVICES_SELECTED" | grep -q "$SERVICE"; then
        case $SERVICE in
            1) SERVICES_TO_DISABLE="$SERVICES_TO_DISABLE envoy";;
            2) SERVICES_TO_DISABLE="$SERVICES_TO_DISABLE core redis";;
            3) SERVICES_TO_DISABLE="$SERVICES_TO_DISABLE observer";;
            4) SERVICES_TO_DISABLE="$SERVICES_TO_DISABLE resolver";;
            5) SERVICES_TO_DISABLE="$SERVICES_TO_DISABLE litestream";;
        esac
    fi
done

# Create docker-compose.override.yml to add 'donotstart' profile for the services the user did not select
if [ -n "$SERVICES_TO_DISABLE" ]; then
    echo "services:" >> docker-compose.override.yml

    for SERVICE in $SERVICES_TO_DISABLE; do
        echo "  $SERVICE:" >> docker-compose.override.yml
        echo "    profiles:" >> docker-compose.override.yml
        echo "      - donotstart" >> docker-compose.override.yml
    done

    print_success "Great! Your node will start with only the services you selected enabled 🛠️"
else
    print_message "Uhu! Your node will start with all services enabled 🛠️"
fi

# Step 5: Configure START_HEIGHT and STOP_HEIGHT
echo "";
print_message "Now let's take a look at the settings for your node node"
echo "";

# Prompt for START_HEIGHT
print_question "By default, your node will sync from block 0. If you want to start from a specific block, enter the block number. Otherwise, leave it empty."
read -r START_HEIGHT
if [ -n "$START_HEIGHT" ]; then
    update_or_add_env_var "START_HEIGHT" "$START_HEIGHT"
    print_success "Your node will start syncing from block $START_HEIGHT"
else
    print_message "Your node will start syncing from block 0"
fi
echo ""

# Prompt for STOP_HEIGHT
print_question "Your node will sync indefinitely by default. If you want to stop at a specific block, enter the block number. Otherwise, leave it empty."
read -r STOP_HEIGHT
if [ -n "$STOP_HEIGHT" ]; then
    update_or_add_env_var "STOP_HEIGHT" "$STOP_HEIGHT"
    print_success "Your node will stop syncing at block $STOP_HEIGHT"
else
    print_message "Your node will sync indefinitely"
fi
echo ""

# Step 6: Ask if the user wants the node to resolve ArNS names
print_question "Do you want your node to resolve ArNS names? (y/n)"
read -r RESOLVE_ARNS

if [ "$RESOLVE_ARNS" = "y" ] || [ "$RESOLVE_ARNS" = "Y" ]; then
    print_question "Please enter the domain that your node will use for resolving ArNS names (e.g., example.com)."
    read -r ARNS_ROOT_HOST
    if [ -n "$ARNS_ROOT_HOST" ]; then
        update_or_add_env_var "ARNS_ROOT_HOST" "$ARNS_ROOT_HOST"

        # Check if the resolver service was selected
        if ! echo "$SERVICES_SELECTED" | grep -q "4"; then
            print_message "You chose to resolve ArNS names, but the resolver service is not enabled. The resolver service is necessary for this feature."
            print_question "Do you want to enable the resolver service? (y/n)"
            read -r ENABLE_RESOLVER

            if [ "$ENABLE_RESOLVER" = "y" ] || [ "$ENABLE_RESOLVER" = "Y" ]; then
                # Remove override for resolver in docker-compose.override.yml
                sed -i '/resolver:/,+2d' docker-compose.override.yml 2>/dev/null
                print_success "Resolver service enabled"

                update_or_add_env_var "TRUSTED_ARNS_RESOLVER_TYPE" "resolver"
                update_or_add_env_var "TRUSTED_ARNS_RESOLVER_URL" "http://resolver:6000"
            else
                print_error "ArNS name resolution requires the resolver service. The resolver service will not be enabled, so ArNS resolution cannot be completed."
                exit 1
            fi
        else
            # Add TRUSTED_ARNS_RESOLVER_TYPE and TRUSTED_ARNS_RESOLVER_URL to .env if resolver was already selected
            update_or_add_env_var "TRUSTED_ARNS_RESOLVER_TYPE" "resolver"
            update_or_add_env_var "TRUSTED_ARNS_RESOLVER_URL" "http://resolver:6000"
        fi
    else
        print_error "Domain cannot be empty if ArNS resolution is enabled."
        exit 1
    fi
else
    print_message "ArNS name resolution will be disabled for your node."
fi

# Step 7: Ask about unbundling bundles to index data items
echo ""
print_question "Do you want to unbundle bundles to index data items? (always/never/custom)"
echo "ℹ️  The default behavior is 'never'. If you choose 'custom', please refer to the documentation at https://github.com/ar-io/ar-io-node/blob/main/README.md#unbundling"
read -r UNBUNDLE_CHOICE

case "$UNBUNDLE_CHOICE" in
    always)
        UNBUNDLE_SETTING='{ "always": true }'
        ;;
    never|"")
        UNBUNDLE_SETTING='{ "never": true }'
        ;;
    custom)
        print_question "Please enter your custom configuration for unbundling:"
        read -r CUSTOM_UNBUNDLE_SETTING
        UNBUNDLE_SETTING="$CUSTOM_UNBUNDLE_SETTING"
        ;;
    *)
        print_error "Invalid option selected. Defaulting to 'never'."
        UNBUNDLE_SETTING='{ "never": true }'
        ;;
esac

# Set the ANS104_UNBUNDLE_FILTER in .env
update_or_add_env_var "ANS104_UNBUNDLE_FILTER" "$UNBUNDLE_SETTING"

# If unbundling is allowed, ask about indexing data items from bundles
if [ "$UNBUNDLE_CHOICE" != "never" ]; then
    print_question "Do you want to index data items from the bundles you allowed to be processed? (always/never/custom)"
    read -r INDEX_CHOICE

    case "$INDEX_CHOICE" in
        always)
            INDEX_SETTING='{ "always": true }'
            ;;
        never|"")
            INDEX_SETTING='{ "never": true }'
            ;;
        custom)
            print_question "Please enter your custom configuration for indexing data items:"
            read -r CUSTOM_INDEX_SETTING
            INDEX_SETTING="$CUSTOM_INDEX_SETTING"
            ;;
        *)
            print_error "Invalid option selected. Defaulting to 'never'."
            INDEX_SETTING='{ "never": true }'
            ;;
    esac

    # Set the ANS104_INDEX_FILTER in .env
    update_or_add_env_var "ANS104_INDEX_FILTER" "$INDEX_SETTING"
else
    print_message "Indexing of data items from bundles will be disabled by default."
fi

# Final Step: Start the Node
echo ""
print_message "Starting your AR.IO node services with Docker Compose... ⏳"
echo ""
docker compose up -d
echo ""

if [ $? -eq 0 ]; then
    print_success "Your AR.IO node services are now running in the background! 🎉"
else
    print_error "There was an issue starting your AR.IO node services. Please check the output above for details."
    exit 1
fi

echo ""
echo ""
print_message "You're now ready to rock! 🚀 Your AR.IO node is set up and running."

print_message "To manage your services, you can use the following Docker Compose commands:"
echo "➡️ Use 'docker compose up' to start the services in the foreground."
echo "➡️ Use 'docker compose down' to stop the services."

echo ""
print_message "We highly recommend that you read the documentation for more detailed configurations and to make the most out of your node:"
print_message "AR.IO Node Repository: https://github.com/ar-io/ar-io-node"
print_message "AR.IO Node Overview Docs: https://docs.ar.io/gateways/ar-io-node/overview/"

echo ""
print_success "Congratulations for setting up your AR.IO node! Happy syncing! 🎉"
