# Windows Installation Instructions

## Overview
This guide provides step-by-step instructions for setting up the ar.io node on a Windows computer. It covers installing necessary software, cloning the repository, creating an environment file, starting the Docker container, setting up networking, and installing and configuring NGINX Docker. No prior coding experience is required.

## Prerequisites
Before starting the installation process, ensure you have the following:

- A Windows computer
- Administrative privileges on the computer

## Install Required Packages

1. Install GitHub CLI (gh):
    - Download the latest release of gh CLI from [here](https://github.com/cli/cli/releases/tag/v2.31.0).
    - Run the `gh-cli-latest.windows-amd64.msi` installer and follow the prompts.

2. Install Docker:
    - Download Docker Desktop for Windows from [here](https://www.docker.com/products/docker-desktop/).
    - Run the installer and follow the prompts.
    - During installation, make sure to select the option to use WSL (Windows Subsystem for Linux) rather than Hyper-V.
    - Restart your PC.
    - Update Windows Subsystem for Linux (WSL):
        - Open the command prompt as an administrator:
            - Press Windows Key + R.
            - Type cmd and press Enter.
            - Right-click on the "Command Prompt" application in the search results.
            - Select "Run as administrator" from the context menu.
        - Run the following commands:
            ```
            wsl --update
            wsl --shutdown
            ```
    - Restart Docker Desktop.

3. Install Git:
    - Download Git for Windows from [here](https://git-scm.com/download/win).
    - Run the installer and use the default settings.

## Clone the Repository

1. Clone the main repository:
    - Open the command prompt:
        - Press `Windows Key + R`.
        - Type `cmd` and press `Enter`.
    - Navigate to the directory where you want to clone the repository:
        - Use the `cd` command to change directories. For example, to navigate to the `Documents` directory:
            ```
            cd Documents
            ```
            - More detailed instructions on navigating with the `cd` command can be found [here](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cd)
            - **NOTE**: Your database of Arweave Transaction Headers will be created in the project directory, not Docker. So, if you are using an external hard drive to turn an old machine into a node, install the node directly to that external drive.
    - Run the following command:
        ```
        gh repo clone ar-io/ar-io-node
        ```

## Create the Environment File

1. Create a ".env" file:
    - Open a text editor (e.g., Notepad):
        - Press `Windows Key` and search for "Notepad".
        - Click on "Notepad" to open the text editor.
    - Paste the following content into the new file, replacing \<your-domain> with the domain address you are using to access the node:
        ```
        GRAPHQL_HOST=arweave.net
        GRAPHQL_PORT=443
        START_HEIGHT=1000000
        ARNS_ROOT_HOST=<your-domain>
        ```
        - The GRAPHQL values set the proxy for GQL queries to arweave.net, You may use any available gateway that supports GQL queries. If omitted, your node can support GQL queries on locally indexed transactions, but only L1 transactions are indexed by default.
        - `START_HEIGHT` is an optional line. It sets the block number where your node will start downloading and indexing transactions headers. Omitting this line will begin indexing at block 0.
        - `ARNS_ROOT_HOST` sets the starting point for resolving ARNS names, which are accessed as a subdomain of a gateway. It should be set to the url you are pointing to your node, excluding any protocol prefix. For example, use `node-ar.io` and not `https://node-ar.io`. If you are using a subdomain to access your node and do not set this value, the node will not understand incoming requests.
    - Save the file with the name ".env" and make sure to select "All Files" as the file type. This helps to ensure the file saves as ".env" and not ".env.txt"

    **Note**: The `.env` file should be saved inside the same directory where you cloned the repository (e.g., `ar-io-node`).

## Start the Docker Containers

1. Start the Docker container:
   - Open the command prompt:
     - Press `Windows Key + R`.
     - Type `cmd` and press `Enter`.
   - Navigate to the directory where you cloned the repository (e.g., `ar-io-node`):
     - Use the `cd` command to change directories. For example, if the repository is located in the `Documents` directory, you would enter:
       ```
       cd Documents\ar-io-node
       ```
     - If the directory path contains spaces, enclose it in double quotation marks. For example:
       ```
       cd "C:\My Documents\ar-io-node"
       ```
     - Use the `dir` command to list the contents of the current directory and verify that you're in the correct location:
       ```
       dir
       ```
   - Once you are in the correct directory, run the following command to start the Docker container:
     ```
     docker compose up -d --build
     ```
     - Explanation of flags:
        - `up`: Start the Docker containers.
        - `-d`: Run the containers as background processes (detached mode).
        - `--build`: Build a new container for the project. Use this flag when you make changes to the code or environmental variables.
   - If prompted by the firewall, allow access for Docker when requested.


## Test Localhost

- Open your web browser.
- Enter `http://localhost:3000/3lyxgbgEvqNSvJrTX2J7CfRychUD5KClFhhVLyTPNCQ` in the address bar.
- If you can see the image, your node is operating correctly.

## Set Up Router Port Forwarding

To expose your node to the internet and use a custom domain, follow these steps:

1. Obtain a Domain Name:
    - Choose a domain registrar (e.g., [Namecheap](https://www.namecheap.com)) and purchase a domain name.

2. Point the Domain at Your Home Network:
    - In your browser, go to https://www.whatsmyip.org/ to display your public ip address. It can be found at the top of the screen. Note this number down.
    - Access your domain registrar's settings (e.g., Namecheap's cPanel).
    - Navigate to the DNS settings for your domain. In cPanel this is under the "Zone Editor" tab.
    - Create an A record with your registrar for your domain and wildcard subdomains, using your public IP address. For example, if your domain is "ar.io," create a record for "ar.io" and "*.ar.io."
        - Instructions may vary depending on the domain registrar and cPanel. Consult your registrar's documentation or support for detailed steps.

3. Obtain the Local IP Address of Your Machine:
    - Open the command prompt:
        - Press `Windows Key + R`.
        - Type `cmd` and press `Enter`.
    - Run the following command:
        ```
        ipconfig
        ```
    - Look for the network adapter that is currently connected to your network (e.g., Ethernet or Wi-Fi).
    - Note down the IPv4 Address associated with the network adapter. It should be in the format of `192.168.X.X` or `10.X.X.X`.
    - This IP address will be used for port forwarding.

4. Set Up Router Port Forwarding:
    - Access your home router settings:
        - Open a web browser.
        - Enter your router's IP address in the address bar (e.g., `192.168.0.1`).
        - If you're unsure of your router's IP address, consult your router's documentation or contact your Internet Service Provider (ISP).
    - Navigate to the port forwarding settings in your router configuration.
        - The exact steps may vary depending on your router model. Consult your router's documentation or support for detailed steps.
    - Set up port forwarding rules to forward incoming traffic on ports 80 and 443 to the local IP address of your machine where the node is installed.
        - Configure the ports to point to the local IP address noted in the previous step.
        - Save the settings.

## Install and Configure NGINX Docker

1. Clone the NGINX Docker repository:
    - Open the command prompt:
        - Press `Windows Key + R`.
        - Type `cmd` and press `Enter`.
    - Navigate to the directory where you want to clone the repository (This should not be done inside the directory for the node):
        - Use the `cd` command to change directories. For example, to navigate to the `Documents` directory:
            ```
            cd Documents
            ```
    - Run the following command:
        ```
        gh repo clone bobinstein/dockerized-nginx
        ```

    **Note**: This NGINX container was designed to easily automate many of the more technical aspects of setting up NGNIX and obtaining an ssl certificate so your node can be accessed with https. However, wildcard domain certifications cannot be universally automated due to significant security concerns. Be sure to follow the instructions in this project for obtaining wildcard domain certificates in order for your node to function properly. 

2. Follow the instructions provided in the repository for setting up NGINX Docker.

Congratulations! Your ar.io node is now running and connected to the internet. Test it by entering https://\<your-domain>/3lyxgbgEvqNSvJrTX2J7CfRychUD5KClFhhVLyTPNCQ in your browser.

**Note**: If you encounter any issues during the installation process, please seek assistance from the [ar.io community](https://discord.gg/7zUPfN4D6g).
