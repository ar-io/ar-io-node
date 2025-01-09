# Linux Installation Instructions

## Overview
The following instructions will guide you through the process of installing the AR.IO node on a Linux machine, specifically Ubuntu 22.04.3 desktop on a home computer. Actual steps may differ slightly on different versions or distributions. This guide will cover how to set up your node, point a domain name to your home network, and create an nginx server for routing traffic to your node. No prior coding experience is required.

## System Requirements

Please note, The AR.IO Node software is still in development and testing, all system requirements are subject to change.

External storage devices should be formatted as ext4.

### Minimum requirements

The hardware specifications listed below represent the minimum system requirements at which the AR.IO Node has been tested. While your Node may still operate on systems with lesser specifications, please note that AR.IO cannot guarantee performance or functionality under those conditions. Use below-minimum hardware at your own risk.

- 4 core CPU
- 4 GB Ram
- 500 GB storage (SSD recommended)
- Stable 50 Mbps internet connection


### Recommended

- 12 core CPU
- 32 GB Ram
- 2 TB SSD storage
- Stable 1 Gbps internet connection


## Install Packages

If you would like to quickly install all required and suggested packages, you can run the following 4 commands in your terminal, and skip to [installing the Node](#install-the-node).


```bash
sudo apt update -y && sudo apt upgrade -y && sudo apt install -y curl openssh-server git certbot nginx sqlite3 build-essential && sudo systemctl enable ssh && curl -sSL https://dl.yarnpkg.com/debian/pubkey.gpg | sudo apt-key add - && echo "deb https://dl.yarnpkg.com/debian/ stable main" | sudo tee /etc/apt/sources.list.d/yarn.list && sudo apt-get update -y && sudo apt-get install -y yarn && curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash && source ~/.bashrc && sudo ufw allow 22 80 443 && sudo ufw enable
```

```bash
# Add Docker's official GPG key:
sudo apt-get update
sudo apt-get install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add the repository to Apt sources:
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
```

```bash
sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

```bash
nvm install 20.11.1 && nvm use 20.11.1
```

### Required packages


1. Update your software:
    ```
    sudo apt update
    sudo apt upgrade
    ```


2. Enable your firewall and open necessary ports:
    ```
    sudo ufw enable

    # Optional: If using SSH, allow port 22
    sudo ufw allow 22

    # Allow ports 80 and 443 for HTTP and HTTPS
    sudo ufw allow 80
    sudo ufw allow 443
    ```


3. Install nginx:
    ```
    sudo apt install nginx -y
    ```


4. Install git:
    ```
    sudo apt install git -y
    ```


5. Install Docker:
    ```
     # Add Docker's official GPG key:
    sudo apt-get update
    sudo apt-get install ca-certificates curl
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc

    # Add the repository to Apt sources:
    echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update
    ```

    ```
    sudo apt-get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ```
    - Test Docker installation:
        ```
        sudo docker run hello-world
        ```


6. Install Certbot:
    ```
    sudo apt install certbot -y
    ```


### Suggested packages

These packages are not required to run a node in its basic form. However, they will become necessary for more advanced usage or customization.


7. Install ssh (optional, for remote access to your Linux machine):
    ```
    sudo apt install openssh-server -y
    sudo systemctl enable ssh
    ```


8. Install Yarn:
    ```
    curl -sSL https://dl.yarnpkg.com/debian/pubkey.gpg | sudo apt-key add -

    echo "deb https://dl.yarnpkg.com/debian/ stable main" | sudo tee /etc/apt/sources.list.d/yarn.list

    sudo apt-get update -y

    sudo apt-get install yarn -y
    ```


9. Install NVM (Node Version Manager):
    ```
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
    source ~/.bashrc
    ```


10. Install Node.js:
    ```
    nvm install 16.15.1
    ```


11. Install build tools:
    ```
    sudo apt install build-essential
    ```

12. Install SQLite:
    ```
    sudo apt install sqlite3 -y
    ```


## Install the Node

- Navigate to the desired installation location:
    - **NOTE**: Your indexing databases will be created in the project directory unless otherwise specified in your .env file, not your Docker environment. So, if you are using an external hard drive, you should install the node directly to that external drive.

- Clone the ar-io-node repository and navigate into it:
    ```
    git clone -b main https://github.com/ar-io/ar-io-node
    cd ar-io-node
    ```

- Create an environment file:

    ```
    nano .env
    ```

    Paste the following content into the new file, replacing \<your-domain> with the domain address you are using to access the node, save, and exit:

    ```
    GRAPHQL_HOST=arweave.net
    GRAPHQL_PORT=443
    START_HEIGHT=1000000
    ARNS_ROOT_HOST=<your-domain>
    ```

    - The GRAPHQL values set the proxy for GQL queries to arweave.net, You may use any available gateway that supports GQL queries. If omitted, your node can support GQL queries on locally indexed transactions, but only L1 transactions are indexed by default.
    - `START_HEIGHT` is an optional line. It sets the block number where your node will start downloading and indexing transactions headers. Omitting this line will begin indexing at block 0.
    - `ARNS_ROOT_HOST` sets the starting point for resolving ARNS names, which are accessed as a subdomain of a gateway. It should be set to the url you are pointing to your node, excluding any protocol prefix. For example, use `node-ar.io` and not `https://node-ar.io`. If you are using a subdomain to access your node and do not set this value, the node will not understand incoming requests.

    - More advanced configuration options can be found at [ar.io/docs](https://ar.io/docs/gateways/ar-io-node/advanced-config.html)

- Start the Docker container:
    ```
    sudo docker compose up -d
    ```
    - Explanation of flags:
        - `up`: Start the Docker containers.
        - `-d`: Run the containers as background processes (detached mode).

    **NOTE**: Effective with Release #3, it is no longer required to include the `--build` flag when starting your gateway. Docker will automatically build using the image specified in the `docker-compose.yaml` file.

To ensure your node is running correctly, follow the next two steps.

- Check the logs for errors:
    ```
    sudo docker compose logs -f --tail=0
    ```
    - Explanation of flags:
        - `-f`: Follow the logs in real time.
        - `--tail=0`: Ignore all logs from before running the command.

**NOTE**:  Previous versions of these instructions advised checking a gateway's ability to fetch content using `localhost`. Subsequent security updates prevent this without first unsetting `ARNS_ROOT_HOST` in your `.env`.

## Set up Networking

The following guide assumes you are running your node on a local home computer.

- Register a Domain Name:
    Choose a domain registrar (e.g., [Namecheap](https://www.namecheap.com)) to register a domain name.

- Point the Domain at Your Home Internet:
    - Obtain your public IP address by visiting https://www.whatsmyip.org/ or running:

        ```
        curl ifconfig.me
        ```
    - Create an A record with your registrar for your domain and wildcard subdomains, using your public IP address. For example, if your domain is "ar.io," create a record for "ar.io" and "*.ar.io."

- Set up Port Forwarding:
    - Obtain the local IP address of the machine where the node is installed by running:
        ```
        ip addr show | grep -w inet | awk '{print $2}' | awk -F'/' '{print $1}'
        ```
        - If there are multiple lines of output, choose the one starting with 192 (usually).
    - Enter your router's IP address in the address bar of a browser (e.g., `192.168.0.1`).
        - If you're unsure of your router's IP address, consult your router's documentation or contact your Internet Service Provider (ISP).
    - Navigate to the port forwarding settings in your router configuration.
        - The exact steps may vary depending on your router model. Consult your router's documentation or support for detailed steps.
    - Set up port forwarding rules to forward incoming traffic on ports 80 (HTTP) and 443 (HTTPS) to the same ports on the machine running your node. You may also forward port 22 if you want to enable SSH access to your node from outside your home network.

- Create SSL (HTTPS) Certificates for Your Domain:
    ```
    sudo certbot certonly --manual --preferred-challenges dns --email <your-email-address> -d <your-domain>.com -d '*.<your-domain>.com'
    ```
    Follow the instructions to create the required TXT records for your domain in your chosen registrar. Use a [DNS checker](https://dnschecker.org/) to verify the propagation of each record.

    **IMPORTANT**: Wild card subdomain (*.\<your-domain>.com) cannot auto renew without obtaining an API key from your domain registrar. Not all registrars offer this. Certbot certificates expire every 90 days. Be sure to consult with your chosen registrar to see if they offer an API for this purpose, or run the above command again to renew your certificates. You will receive an email warning at the address you provided to remind you when it is time to renew.

- Configure nginx:
    nginx is a free and open-source web server and reverse proxy server. It will handle incoming traffic, provide SSL certificates, and redirect the traffic to your node.
    - Open the default configuration file:
        ```
        sudo nano /etc/nginx/sites-available/default
        ```
    - Replace the file's contents with the following configuration (replace "\<your-domain>" when necessary):
        ```
        # Force redirects from HTTP to HTTPS
        server {
            listen 80;
            listen [::]:80;
            server_name <your-domain>.com *.<your-domain>.com;

            location / {
                return 301 https://$host$request_uri;
            }
        }

        # Forward traffic to your node and provide SSL certificates
        server {
            listen 443 ssl;
            listen [::]:443 ssl;
            server_name <your-domain>.com *.<your-domain>.com;

            ssl_certificate /etc/letsencrypt/live/<your-domain>.com/fullchain.pem;
            ssl_certificate_key /etc/letsencrypt/live/<your-domain>.com/privkey.pem;

            location / {
                proxy_pass http://localhost:3000;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_http_version 1.1;
            }
        }
        ```
    - Save and exit nano.
    - Test the configuration:
        ```
        sudo nginx -t
        ```
    - If there are no errors, restart nginx:
        ```
        sudo service nginx restart
        ```

Your node should now be running and connected to the internet. Test it by entering https://\<your-domain>/3lyxgbgEvqNSvJrTX2J7CfRychUD5KClFhhVLyTPNCQ in your browser.

**Note**: If you encounter any issues during the installation process, please seek assistance from the [AR.IO community](https://discord.gg/7zUPfN4D6g).
