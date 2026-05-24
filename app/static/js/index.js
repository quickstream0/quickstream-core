// Mobile menu toggle
const mobileMenu = document.getElementById('mobileMenu');
const mainNav = document.getElementById('mainNav');

mobileMenu.addEventListener('click', function() {
    mainNav.classList.toggle('active');
    mobileMenu.innerHTML = mainNav.classList.contains('active') 
        ? '<i class="fas fa-times"></i>' 
        : '<i class="fas fa-bars"></i>';
});

// Content tabs functionality
const tabs = document.querySelectorAll('.content-tab');
tabs.forEach(tab => {
    tab.addEventListener('click', function() {
        // Remove active class from all tabs
        tabs.forEach(t => t.classList.remove('active'));
        // Add active class to clicked tab
        this.classList.add('active');
        
        // In a real implementation, this would update the content grid
        // based on the selected category
    });
});

// Smooth scrolling for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        
        const targetId = this.getAttribute('href');
        if(targetId === '#') return;
        
        const targetElement = document.querySelector(targetId);
        if(targetElement) {
            window.scrollTo({
                top: targetElement.offsetTop - 80,
                behavior: 'smooth'
            });
            
            // Close mobile menu if open
            mainNav.classList.remove('active');
            mobileMenu.innerHTML = '<i class="fas fa-bars"></i>';
        }
    });
});

// Platform card click handling - navigate to platform page
document.querySelectorAll('.platform-card').forEach(card => {
    // Make the whole card clickable
    card.style.cursor = 'pointer';
    
    card.addEventListener('click', (e) => {
        // Prevent navigation if clicking on the download button
        // if (e.target.classList.contains('platform-download-btn')) {
        //     e.stopPropagation();
        //     const platform = e.target.getAttribute('data-platform');
        //     window.location.href = `/${platform}/download`;
        //     return;
        // }
        
        // Navigate to platform page
        const route = card.getAttribute('data-route');
        if (route) {
            window.location.href = route;
        }
    });
});


// FAQ Accordion Functionality
const faqItems = document.querySelectorAll('.faq-item');

faqItems.forEach(item => {
    const question = item.querySelector('.faq-question');
    
    question.addEventListener('click', () => {
        // Close all other items
        faqItems.forEach(otherItem => {
            if (otherItem !== item && otherItem.classList.contains('active')) {
                otherItem.classList.remove('active');
            }
        });
        
        // Toggle current item
        item.classList.toggle('active');
    });
});

// Optional: Open first FAQ by default on page load
window.addEventListener('DOMContentLoaded', () => {
    if (faqItems.length > 0) {
        faqItems[0].classList.add('active');
    }
});

// CTA button handler
document.querySelectorAll('.cta-button').forEach(button => {
    button.addEventListener('click', function() {
        if(this.textContent.includes('Download')) {
            document.getElementById('download').scrollIntoView({ behavior: 'smooth' });
        } else if(this.textContent.includes('Explore') || this.textContent.includes('How It Works')) {
            window.scrollTo({
                top: document.getElementById('content').offsetTop - 80,
                behavior: 'smooth'
            });
        }
    });
});

// Download button handlers
document.querySelectorAll('.download-btn').forEach(button => {
    button.addEventListener('click', function() {
        const platform = this.getAttribute('data-platform');
        const downloadUrl = this.getAttribute('data-url');
        
        if (downloadUrl && downloadUrl !== '#') {
            // Show download notification
            showDownloadNotification(platform);
            // Trigger download
            window.open(downloadUrl, '_blank');
        } else {
            // Show coming soon message
            showComingSoon(platform);
        }
    });
});

// Store buttons
document.querySelectorAll('.download-store-btn').forEach(button => {
    button.addEventListener('click', function() {
        const platform = this.getAttribute('data-platform');
        showStoreRedirect(platform);
    });
});

// Notification functions
function showDownloadNotification(platform) {
    const platformNames = {
        android: 'Android',
        ios: 'iOS',
        windows: 'Windows',
        macos: 'macOS',
        linux: 'Linux'
    };
    
    showToast(`Downloading QuickStream for ${platformNames[platform]}...`);
}

function showComingSoon(platform) {
    const platformNames = {
        android: 'Android',
        ios: 'iOS',
        windows: 'Windows',
        macos: 'macOS',
        linux: 'Linux'
    };
    
    showToast(`QuickStream for ${platformNames[platform]} is coming soon! Stay tuned.`, 3000);
}

function showStoreRedirect(platform) {
    const storeNames = {
        'android-store': 'Google Play Store',
        'ios-store': 'App Store',
        'windows-store': 'Microsoft Store',
        'macos-store': 'Mac App Store',
        'linux-store': 'Snap Store / FlatHub'
    };
    
    showToast(`Redirecting to ${storeNames[platform]}...`, 2000);
}

function showToast(message, duration = 2000) {
    // Check if toast container exists
    let toastContainer = document.querySelector('.toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
        
        // Add toast styles if not present
        if (!document.querySelector('#toast-styles')) {
            const style = document.createElement('style');
            style.id = 'toast-styles';
            style.textContent = `
                .toast-container {
                    position: fixed;
                    bottom: 20px;
                    left: 50%;
                    transform: translateX(-50%);
                    z-index: 9999;
                }
                .toast-message {
                    background-color: #323232;
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    font-size: 14px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    animation: slideUp 0.3s ease;
                }
                @keyframes slideUp {
                    from {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
            `;
            document.head.appendChild(style);
        }
    }
    
    const toast = document.createElement('div');
    toast.className = 'toast-message';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.remove();
    }, duration);
}
