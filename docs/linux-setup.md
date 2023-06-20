# Linux Installation Instructions
## Overview
The Ar-io node was designed to easily run on a linux machine. Below are instructions on how to install your own node on Ubuntu 20.04.5 desktop on a home computer, point a domain name at your home network, and create an nginx server to route traffic into your node, using primarily terminal commands.

## Install Required Packages.

1. Ensure your software is up to date
    ```
    sudo apt update
    sudo apt upgrade
    ```

2. ssh (optional, used to run commands on your linux machine remotely)
    ```
    sudo apt install openssh-server
    sudo systemctl enable ssh
    ```
3. Open ports in your firewall

    - Port 22 is optional, and is used to connect to your computer via ssh. Once this is done, you may continue installation remotely from another computer on your network.


    ```
    sudo ufw allow 22
    ```
    ```
    sudo ufw allow 80
    ```
    ```
    sudo ufw allow 443
    ```

4. Yarn
    ```
    sudo snap install yarn --classic
    ```

5. NVM
    ```
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
    source ~/.bashrc
    ```

6.  Nodejs
    ```
    nvm install 16.15.1
    ```

7. nginx
    ``` 
    sudo apt install nginx
    ```

8. git
    ```
    sudo apt install git
    ```

9. github cli
    ```
    sudo snap install gh
    ```

10. Docker
    ```
    sudo apt install docker-compose
    ```
    - Test that Docker installed correctly
        ```
        sudo docker run hello-world
        ```

11. Certbot
    ```
    sudo apt install certbot
    ```

## Install the Node

- Navigate to the location you want to install the node
    - NOTE: Your database of Arweave Transaction Headers will be created in the project directory, not Docker. So, if you are using an external hard drive to turn an old machine into a node, install the node directly to that external drive.

- Clone the ar-io-node repo and navigate into it

    ```
    gh repo clone ar-io/ar-io-node
    cd ar-io-node
    ```

    - Create an env file

    ```
    nano .env
    ```
    Paste the following into the new file before saving and exiting

    ```
    GRAPHQL_HOST=arweave.net
    GRAPHQL_PORT=443
    ```

    These values set the proxy for GQL queries to arweave.net, You may use any available gateway that supports GQL queries.

- Build to Docker

    ```
    sudo docker-compose up -d --build
    ```
    - Explanation of tags
    - `up` is the command to start the Docker containers
    - `-d` runs them as background processes (detached mode) so you may continue to use the same terminal once the build is complete
    - `--build` is the command for Docker to build a container for your project. This tag may be omitted if you are restarting an already built container that you have stopped. Include it if you have made any changes to the code or environmental variables and need the Docker container updated

Your node should now be running, use the next two steps to ensure it is running properly.

- Check the logs for errors

    ```
    sudo docker-compose logs -f --tail=0
    ```
    - Explanation of tags
        - `-f` (follow) watches the logs so they can be viewed in real time
        - `--tail=0` sets the number of lines that will be displayed from the logs from before the logs command was run. It can be set to any number

- Make a request to your node using localhost

    Either in your browser, or using the wget command in your terminal, navigate to http://localhost:3000/3lyxgbgEvqNSvJrTX2J7CfRychUD5KClFhhVLyTPNCQ

    If you can see the image, your node is operating correctly and you may move on to the next steps to expose your node to the internet. 

## Set up networking 

The following guide assumes you are operating your node on a local home computer. 

- Register a Domain Name
    This can be done with any number of domain registrars, like [namecheap](https://www.namecheap.com/?gclid=CjwKCAjwyqWkBhBMEiwAp2yUFvVmCyyLIFIMgHupgaO-c3IhUk_B4IbdSYzAAxUwaYxqMvytNz5e_xoCJYMQAvD_BwE). Domains are usually purchased in increments of 1 or more years and will have to be periodically renewed. The process for purchasing and renewing domains will vary depending on your registrar.

- Point the domain at your home internet

    - Obtain your public ip address, either by going to https://whatismyipaddress.com/ , or running 
        ```
        curl ifconfig.me
        ```
    - Create an A record with your registrar for <your-domain> and *.<your-domain> using your public ip address. For example, if your domain was ar.io, you would create a record for ar.io, and *.ar.io

- Set up Port Forwarding
    - Obtain the local ip of the machine where the node is installed. You can do this by running
        ```
        ip addr show | grep -w inet | awk '{print $2}' | awk -F'/' '{print $1}'
        ```
        - If there are multiple lines of output, it means your machine has multiple network interfaces, the correct one will normally start with 192
    - Go into your home router settings, this can usually be completed by entering `192.168.0.1` in your browser
    - Set up Port Forwarding rules, the process for this will vary depending on your specific brand of router. For simplicity, forward incoming traffic on 80 (http) and 443 (https) to those same ports on the machine where the node is running. You may do the same for port 22 if you want to be able to ssh into the machine running your node from outside your home network.

- Create SSL (https) certificates for your domain
    
    (below is only one of serveral options for generating certificates with certbot, if you have a preferred method, you may use that without affecting the rest of the process)

    ```
    sudo certbot certonly --manual --preferred-challenges dns -d <your-domain>.com -d '*.<your-domain>.com'
    ```

    This will ask you to create TXT records with specific names and contents for your domain so that it can check if you are the actual owner. Do this in your chosen registrar in the same way you created the A records to point your domain at your home network. After each one use a [dns checker](https://dnschecker.org/) to ensure that each record is properly propagated before moving on. This normally only takes a few seconds.

- Configure nginx
    nginx is a web server and reverse proxy server that is free and open source. It will accept traffic that has been forwarded from your router, provide the appropriate security certificates (https) and then redirect the traffic into your node. The following assumes your node is the only process that will be served using nginx. Be sure to replace "<your-domain>" when necessary.

    ```
    sudo nano /etc/sites-available/default
    ```

    This will open the default configuration file for nginx. Delete its contents and replace it with the following

    ```
    # force redirects http to https
    server {
        listen 80;
        listen [::]:80;
        server_name <your-domain>.com *.<your-domain>.com;

        location / {
            return 301 https://$host$request_uri;
        }
    }


    # forwards traffic into your node and provides ssl certificates
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

    - Test the configuration by running 
        ```
        sudo nginx -t
        ```
    - If there are no errors, restart nginx using 
        ```
        sudo service nginx restart
        ```

Your node should now be running and connected to the internet. Test it by entering https://<your-domain>/3lyxgbgEvqNSvJrTX2J7CfRychUD5KClFhhVLyTPNCQ into your browser.

