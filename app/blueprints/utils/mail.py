import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from flask import url_for, current_app
from functools import wraps


class Mail(object):
    def __init__(
        self,
        username,
        password,
        host,
        port,
        use_tls=True,
        **kwargs,
    ) -> None:
        self.__username = username
        self.__password = password
        self.__host = host
        self.__port = port
        self.__use_tls = use_tls

    def send_mail(self, recipients, subject, body, from_name=None):
        # Validate recipients
        if not recipients or not isinstance(recipients, (list, tuple)):
            return {"success": False, "error": "Invalid recipients list"}, False

        # build the mailer
        mime_type = MIMEMultipart()
        if from_name:
            mime_type["From"] = f"{from_name} <{self.__username}>"
        else:
            mime_type["From"] = self.__username
        mime_type["To"] = ",".join(recipients)
        mime_type["Subject"] = subject
        mime_type.attach(MIMEText(body, 'html' if '<' in body else 'plain'))

        try:
            if self.__use_tls:
                # Use TLS encryption
                context = ssl.create_default_context()
                server = smtplib.SMTP(self.__host, self.__port)
                server.starttls(context=context)
            else:
                # Use SSL (like SMTP_SSL)
                context = ssl.create_default_context()
                server = smtplib.SMTP_SSL(self.__host, self.__port, context=context)
            
            server.login(self.__username, self.__password)
            current_app.logger.info("SMTP login successful")
            
            server.sendmail(
                mime_type.get("From", ""), 
                recipients, 
                mime_type.as_string()
            )
            server.quit()
            
            return {"success": True, "message": "Email sent successfully"}, True

        except smtplib.SMTPAuthenticationError as err:
            error = f"SMTP Authentication Error: {err}"
            current_app.logger.error(error)
            return {
                "success": False,
                "error": "Email server authentication failed. Please check your email credentials.",
                "debug": str(err)
            }, False
            
        except smtplib.SMTPException as err:
            error = f"SMTP Error: {err}"
            current_app.logger.error(error)
            return {
                "success": False,
                "error": "Failed to send email due to server error.",
                "debug": str(err)
            }, False
            
        except Exception as err:
            error = f"Unexpected Error: {err}"
            current_app.logger.error(error)
            return {
                "success": False,
                "error": "An unexpected error occurred while sending email.",
                "debug": str(err)
            }, False