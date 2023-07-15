# Linux Installation Instructions

## Overview
The following instructions will guide you through the process of installing the ar.io node on a Linux machine, specifically Ubuntu 20.04.5 desktop on a home computer. Actual steps may differ slightly on different versions or distributions. This guide will cover how to set up your node, point a domain name to your home network, and create an nginx server for routing traffic to your node. No prior coding experience is required.

## Install Required Packages

1. Update your software:
    ```
    sudo apt update
    sudo apt upgrade
    ```

2. Install ssh (optional, for remote access to your Linux machine):
    ```
    sudo apt install openssh-server
    sudo systemctl enable ssh
    ```

3. Open necessary ports in your firewall:
    ```
    # Optional: If using SSH, allow port 22 
    sudo ufw allow 22

    # Allow ports 80 and 443 for HTTP and HTTPS
    sudo ufw allow 80
    sudo ufw allow 443
    ```

4. Install Yarn:
    ```
    sudo snap install yarn --classic
    ```

5. Install NVM (Node Version Manager):
    ```
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
    source ~/.bashrc
    ```

6. Install Node.js:
    ```
    nvm install 16.15.1
    ```

7. Install nginx:
    ```
    sudo apt install nginx
    ```

8. Install git:
    ```
    sudo apt install git
    ```

9. Install GitHub CLI:
    ```
    sudo snap install gh
    ```

10. Install Docker:
    ```
    sudo apt install docker-compose
    ```
    - Test Docker installation:
        ```
        sudo docker run hello-world
        ```

11. Install Certbot:
    ```
    sudo apt install certbot
    ```

## Install the Node

- Navigate to the desired installation location:
    - **NOTE**: Your database of Arweave Transaction Headers will be created in the project directory, not Docker. So, if you are using an external hard drive to turn an old machine into a node, install the node directly to that external drive.

- Clone the ar-io-node repository and navigate into it:
    ```
    gh repo clone ar-io/ar-io-node
    cd ar-io-node
    ```

- Create an environment file:
    ```
    nano .env
    ```
    Paste the following content into the new file, save, and exit:
    ```
    GRAPHQL_HOST=arweave.net
    GRAPHQL_PORT=443
    START_HEIGHT=1000000
    ```
    - The GRAPHQL values set the proxy for GQL queries to arweave.net, You may use any available gateway that supports GQL queries. Your node can handle direct GQL queries, but only indexes L1 transactions by default and will fall back on your chosen proxy for any transactions not indexed.
    - `START_HEIGHT` is an optional line. It sets the block number where your node will start downloading and indexing transactions headers. Omitting this line will begin indexing at block 0.

- Build the Docker container:
    ```
    sudo docker-compose up -d --build
    ```
    - Explanation of flags:
        - `up`: Start the Docker containers.
        - `-d`: Run the containers as background processes (detached mode).
        - `--build`: Build a new container for the project. Use this flag when you make changes to the code or environmental variables.

To ensure your node is running correctly, follow the next two steps.

- Check the logs for errors:
    ```
    sudo docker-compose logs -f --tail=0
    ```
    - Explanation of flags:
        - `-f`: Follow the logs in real time.
        - `--tail=0`: Ignore all logs from before running the command.

- Make a request to your node using localhost:
    Open your browser or use the `wget` command in the terminal to navigate to http://localhost:3000/3lyxgbgEvqNSvJrTX2J7CfRychUD5KClFhhVLyTPNCQ.
    If you can see the image, your node is operating correctly.

## Set up Networking

The following guide assumes you are running your node on a local home computer.

- Register a Domain Name:
    Choose a domain registrar (e.g., [Namecheap](https://www.namecheap.com)) to register a domain name.

    - **Note**: The domain should be a base domain ("ardrive.io"), do not use a subdomain ("docs.ardrive.io").

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
        sudo nano /etc/sites-available/default
        ```
    - Replace the file's contents with the following configuration (replace "<your-domain>" when necessary):
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

**Note**: If you encounter any issues during the installation process, please seek assistance from the [ar.io community](https://discord.gg/7zUPfN4D6g).