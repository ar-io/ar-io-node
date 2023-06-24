# Linux Installation Instructions

## Overview
The following instructions will guide you through the process of installing the Ar-io node on a Linux machine, specifically Ubuntu 20.04.5 desktop on a home computer. This guide will cover how to set up your node, point a domain name to your home network, and create an nginx server for routing traffic to your node. No prior coding experience is required.

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
    sudo ufw allow 22
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
    - NOTE: Your database of Arweave Transaction Headers will be created in the project directory, not Docker. So, if you are using an external hard drive to turn an old machine into a node, install the node directly to that external drive.

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
    ```
    - These values set the proxy for GQL queries to arweave.net, You may use any available gateway that supports GQL queries.

- Build the Docker container:
    ```
    sudo docker-compose up -d --build
    ```
    - Explanation of tags:
        - `up`: Start the Docker containers.
        - `-d`: Run the containers as background processes (detached mode).
        - `--build`: Build a new container for the project. Use this tag when you make changes to the code or environmental variables.

To ensure your node is running correctly, follow the next two steps.

- Check the logs for errors:
    ```
    sudo docker-compose logs -f --tail=0
    ```
    - Explanation of tags:
        - `-f`: Follow the logs in real time.
        - `--tail=0`: Ignore all logs from before running the command.

- Make a request to your node using localhost:
    Open your browser or use the `wget` command in the terminal to navigate to http://localhost:3000/3lyxgbgEvqNSvJrTX2J7CfRychUD5KClFhhVLyTPNCQ.
    If you can see the image, your node is operating correctly.

## Set up Networking

The following guide assumes you are running your node on a local home computer.

- Register a Domain Name:
    Choose a domain registrar (e.g., [namecheap](https://www.namecheap.com/?gclid=CjwKCAjwyqWkBhBMEiwAp2yUFvVmCyyLIFIMgHupgaO-c3IhUk_B4IbdSYzAAxUwaYxqMvytNz5e_xoCJYMQAvD_BwE)) to register a domain name. Domains are usually purchased for a specific duration and need to be periodically renewed.

    - **NOTE:** The domain you use must be a base level domain. Due to the way Arns names work, using a subdomain to point to your node will not work correctly.

- Point the Domain at Your Home Internet:
    - Obtain your public IP address by visiting https://whatismyipaddress.com/ or running:
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
    - Access your home router settings by entering `192.168.0.1` in your browser while connected to that network. (If this method does not work, consult the documentation for your model of router.)
    - Set up port forwarding rules to forward incoming traffic on ports 80 (HTTP) and 443 (HTTPS) to the same ports on the machine running your node. You may also forward port 22 if you want to enable SSH access to your node from outside your home network.

- Create SSL (HTTPS) Certificates for Your Domain:
    ```
    sudo certbot certonly --manual --preferred-challenges dns -d <your-domain>.com -d '*.<your-domain>.com'
    ```
    Follow the instructions to create the required TXT records for your domain in your chosen registrar. Use a [DNS checker](https://dnschecker.org/) to verify the propagation of each record.

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

Your node should now be running and connected to the internet. Test it by entering https://<your-domain>/3lyxgbgEvqNSvJrTX2J7CfRychUD5KClFhhVLyTPNCQ in your browser.
