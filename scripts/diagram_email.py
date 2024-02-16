#!/usr/bin/env python3
from email.message import EmailMessage
import smtplib
import base64
import os

file_name = os.environ['DIAGRAM_FILE']

# Create the base email message
msg = EmailMessage()
msg['Subject'] = 'A test diagram'
msg['From'] = os.environ['EMAIL_FROM']
msg['To'] = os.environ['EMAIL_TO']
msg.set_content('Diagram update')

# Add attachment
with open(file_name, 'rb') as f:
    file_data = f.read()

msg.add_attachment(file_data, maintype='application', subtype='octet-stream', filename=file_name)

# Convert to string including headers
raw_email = msg.as_string()

print(raw_email)
