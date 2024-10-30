# Use the Python 3.9 container image
FROM python:3.9

ENV PYTHONUNBUFFERED=1

# Set the working directory to /app
WORKDIR /app

# Install necessary dependencies
# RUN apt-get update && apt-get install -y \
#     chromium-driver \
#     && rm -rf /var/lib/apt/lists/*

# Copy the requirements file into the container at /app
COPY requirements.txt /app

# Install the dependencies
RUN pip install -r requirements.txt

# Copy the rest of the application code into the container
COPY . .

# Set the PYTHONPATH environment variable
ENV PYTHONPATH /app

# Run the application using Gunicorn
CMD ["gunicorn", "--workers", "4", "--threads", "2", "--bind", "0.0.0.0:5000", "run:app"]