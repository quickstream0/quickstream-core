import random
import secrets
import string


class Generate:
    
    def random_string(length=64):
        characters = string.ascii_letters + string.digits
        random_string = ''.join(secrets.choice(characters) for _ in range(length))
        return random_string
    
    def random_string_L(length=64):
        characters = string.ascii_lowercase + string.digits
        random_string = ''.join(random.choice(characters) for _ in range(length))
        return random_string
  
    def random_int():
        return random.randint(1000, 9999)

