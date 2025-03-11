import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText


class Mail(object):
    def __init__(
        self,
        username,
        password,
        host,
        port,
        **kwargs,
    ) -> None:
        self.__username = username
        self.__password = password
        self.__host = host
        self.__port = port

    def send_mail(self, recipients, subject, body, from_name=None):
        # build the mailer
        mime_type = MIMEMultipart()
        if from_name:
            mime_type["From"] = f"{from_name} <{self.__username}>"
        else:
            mime_type["From"] = self.__username
        mime_type["To"] = ",".join(recipients)
        mime_type["Subject"] = subject
        mime_type.attach(MIMEText(body))

        context = ssl.create_default_context()

        resp = {"success": True, "msg": "Send successfully"}

        try:
            with smtplib.SMTP_SSL(self.__host, self.__port, context=context) as server:
                server.login(self.__username, self.__password)
                print("Successful login")
                server.sendmail(
                    mime_type.get("From", ""), recipients, mime_type.as_string()
                )

        except Exception as err:
            error = f"Error: {err}"
            print(err)
            return {"error": error, "success": False}, False

        return resp, True
