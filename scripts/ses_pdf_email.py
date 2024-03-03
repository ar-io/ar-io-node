#!/usr/bin/env python3
from email.message import EmailMessage
import base64
import json
import os
import smtplib

pdf_file = os.environ['PDF_FILE']
email_json_file = os.environ['OUTPUT_JSON_FILE']

# Create the base email message
msg = EmailMessage()
msg['Subject'] = 'PDF: {}'.format(pdf_file)
msg['From'] = os.environ['EMAIL_FROM']
msg['To'] = os.environ['EMAIL_TO']
msg.set_content('PDF: {}'.format(pdf_file))

# Add attachment
with open(pdf_file, 'rb') as f:
    pdf_data = f.read()

msg.add_attachment(pdf_data, maintype='application', subtype='pdf', filename=pdf_file)

# Write the email json to a file
with open(email_json_file, 'w') as f:
    f.write(json.dumps({ 'Data': msg.as_string() }))
