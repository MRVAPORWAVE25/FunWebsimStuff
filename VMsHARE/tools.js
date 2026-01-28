// Screenshot tool for noVNC
class ScreenshotTool {
    constructor() {
        this.canvas = null;
        this.init();
    }

    async init() {
        // Wait for canvas to be available
        await this.waitForCanvas();
        console.log('Screenshot tool initialized');
    }

    waitForCanvas() {
        return new Promise((resolve) => {
            const checkForCanvas = () => {
                this.canvas = document.querySelector('#screen canvas') || 
                             document.querySelector('canvas[tabindex="-1"]') ||
                             document.querySelector('#noVNC_container canvas') ||
                             document.querySelector('canvas');
                
                if (this.canvas) {
                    console.log('Found canvas for screenshot:', this.canvas);
                    resolve(this.canvas);
                } else {
                    setTimeout(checkForCanvas, 100);
                }
            };
            checkForCanvas();
        });
    }

    async screenshot() {
        if (!this.canvas) {
            console.error('Canvas not found for screenshot');
            return false;
        }

        try {
            console.log('Taking screenshot...');
            
            // Convert canvas to blob
            const blob = await new Promise(resolve => {
                this.canvas.toBlob(resolve, 'image/png');
            });

            if (!blob) {
                console.error('Failed to create image blob');
                return false;
            }

            // Upload the image and post comment using websim API
            const success = await this.postScreenshotComment(blob);
            
            if (success) {
                console.log('Screenshot posted successfully');
                return true;
            } else {
                console.error('Failed to post screenshot');
                return false;
            }

        } catch (error) {
            console.error('Error taking screenshot:', error);
            return false;
        }
    }

    async postScreenshotComment(imageBlob) {
        try {
            // Upload the image first
            console.log('Uploading screenshot...');
            const imageUrl = await window.websim.upload(imageBlob);
            
            if (!imageUrl) {
                console.error('Failed to upload image');
                return false;
            }

            console.log('Image uploaded, posting comment...');
            
            // Post comment with the uploaded image
            const result = await window.websim.postComment({
                content: "",  // No text content, just the screenshot
                images: [imageUrl]
            });

            if (result.error) {
                console.error('Error posting comment:', result.error);
                return false;
            }

            console.log('Screenshot comment posted successfully');
            return true;

        } catch (error) {
            console.error('Error posting screenshot comment:', error);
            return false;
        }
    }

    // Alternative method using base64 if FormData doesn't work
    async postScreenshotBase64(imageBlob) {
        try {
            const base64 = await this.blobToBase64(imageBlob);
            
            const payload = {
                type: 'screenshot',
                image: base64,
                timestamp: new Date().toISOString()
            };

            const response = await fetch(this.commentsApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                const result = await response.json();
                console.log('Screenshot comment posted (base64):', result);
                return true;
            } else {
                console.error('API response error:', response.status, response.statusText);
                return false;
            }

        } catch (error) {
            console.error('Error posting screenshot as base64:', error);
            return false;
        }
    }

    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // Set custom API endpoint
    setApiEndpoint(url) {
        this.commentsApiUrl = url;
        console.log('Comments API endpoint set to:', url);
    }
}

// Initialize screenshot tool
const screenshotTool = new ScreenshotTool();

// Expose screenshot function globally
window.screenshot = () => screenshotTool.screenshot();

// Export for use in other scripts
window.ScreenshotTool = ScreenshotTool;
window.screenshotTool = screenshotTool;

console.log('Screenshot tool loaded - use window.screenshot() to take a screenshot');
