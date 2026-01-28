// Enhanced VNC Paste functionality for noVNC
// Focus: Intercept user paste events and send content to VNC server

const waitForCanvas = () => {
    return new Promise((resolve) => {
        const checkForCanvas = () => {
            // Try multiple ways to find the canvas
            let canvas = document.querySelector('#screen canvas') || 
                        document.querySelector('canvas[tabindex="-1"]') ||
                        document.querySelector('#noVNC_container canvas') ||
                        document.querySelector('canvas');
            
            if (canvas) {
                console.log('Found noVNC canvas:', canvas);
                resolve(canvas);
            } else {
                // If not found, wait and try again
                setTimeout(checkForCanvas, 100);
            }
        };
        checkForCanvas();
    });
};

const setupPasteHandling = async () => {
    // Wait for the canvas to be available
    const canvas = await waitForCanvas();
    
    console.log('Setting up paste handling on canvas');
    
    // Listen for paste events on the canvas
    canvas.addEventListener('paste', async (event) => {
        console.log('Paste event detected on canvas');
        
        // Prevent default paste behavior to handle it ourselves
        event.preventDefault();
        
        let pastedText = '';
        
        // Try to get text from clipboard API first
        try {
            pastedText = await navigator.clipboard.readText();
            console.log('Got text from Clipboard API:', pastedText.substring(0, 50) + '...');
        } catch (error) {
            console.log('Clipboard API failed, trying event data:', error.message);
            
            // Fallback: get text from paste event
            if (event.clipboardData && event.clipboardData.getData) {
                pastedText = event.clipboardData.getData('text/plain');
                console.log('Got text from paste event:', pastedText.substring(0, 50) + '...');
            }
        }
        
        // Send the pasted text to VNC server
        if (pastedText) {
            sendTextToVNC(pastedText);
        } else {
            console.log('No text found in paste event');
        }
    });
    
    // Also listen for keydown events on the canvas to catch Ctrl+V/Cmd+V and Ctrl+C/Cmd+C
    canvas.addEventListener('keydown', async (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
            console.log('Paste keyboard shortcut detected on canvas');
            
            // Prevent the default paste behavior
            event.preventDefault();
            
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    console.log('Sending clipboard text to VNC via keyboard shortcut');
                    sendTextToVNC(text);
                }
            } catch (error) {
                console.log('Failed to read clipboard on keyboard shortcut:', error.message);
            }
        }
        else if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
            console.log('Copy keyboard shortcut detected on canvas');
            
            // Prevent the default copy behavior to handle it ourselves
            event.preventDefault();
            
            // Send Ctrl+C to the server first to trigger server-side copy
            copyFromVNC();
        }
    });
    
    // Canvas should already be focusable (noVNC sets tabIndex to -1)
    // Just ensure it can receive paste events by giving it focus when clicked
    canvas.addEventListener('click', () => {
        canvas.focus();
    });
    
    // Also add document-level paste as fallback for when canvas isn't focused
    document.addEventListener('paste', async (event) => {
        // Only handle if the canvas doesn't have focus
        if (document.activeElement !== canvas) {
            console.log('Document paste event - forwarding to canvas');
            
            let pastedText = '';
            try {
                pastedText = await navigator.clipboard.readText();
            } catch (error) {
                if (event.clipboardData && event.clipboardData.getData) {
                    pastedText = event.clipboardData.getData('text/plain');
                }
            }
            
            if (pastedText) {
                event.preventDefault();
                sendTextToVNC(pastedText);
            }
        }
    });
};

const sendTextToVNC = (text) => {
    try {
        const clipboardSender = document.querySelector('#hidden_clipboard_sender');
        if (clipboardSender) {
            clipboardSender.value = text;
            clipboardSender.click();
            console.log('Sent text to VNC server:', text.substring(0, 50) + '...');
        } else {
            console.error('hidden_clipboard_sender element not found');
        }
    } catch (error) {
        console.error('Failed to send text to VNC:', error);
    }
};

// Initialize paste handling
setupPasteHandling();
console.log('VNC paste handling initialized');

// Keep the existing clipboard write function for receiving from VNC server
async function write_clipboard(){
    let txt = document.querySelector('#hidden_clipboard_reciver').value;
    try {
        await navigator.clipboard.writeText(txt);
        console.log('Successfully wrote to local clipboard from VNC server:', txt);
    } catch (error) {
        console.log('Failed to write to clipboard:', error.message);
    }
}
// sync write to local from remote

// Function to copy data from VNC server
function copyFromVNC() {
    // Try multiple ways to access the RFB object
    let rfbObject = null;
    
    // First try the global rfb variable (vnc_lite.html approach)
    if (window.rfb && typeof window.rfb.sendKey === 'function') {
        rfbObject = window.rfb;
    }
    // Fallback to UI.rfb (full noVNC app approach)
    else if (window.UI && window.UI.rfb && typeof window.UI.rfb.sendKey === 'function') {
        rfbObject = window.UI.rfb;
    }
    
    if (rfbObject) {
        console.log('Sending Ctrl+C to VNC server to trigger copy');
        
        // Send Ctrl+C keyboard combination to the server
        // Send Ctrl key down (using correct keysym values)
        rfbObject.sendKey(0xffe3, 'ControlLeft', true);  // XK_Control_L down
        // Send C key down
        rfbObject.sendKey(0x0063, 'KeyC', true);         // XK_c down  
        // Send C key up
        rfbObject.sendKey(0x0063, 'KeyC', false);        // XK_c up
        // Send Ctrl key up  
        rfbObject.sendKey(0xffe3, 'ControlLeft', false); // XK_Control_L up
        
        console.log('Sent Ctrl+C to server - clipboard data should be updated via existing clipboard event listener');
    } else {
        console.error('RFB object not available for copy operation');
        console.log('Available objects:', {
            'window.rfb': !!window.rfb,
            'window.UI': !!window.UI,
            'window.UI.rfb': !!(window.UI && window.UI.rfb)
        });
    }
}

// Function to send clipboard data to VNC server
function send_clipboard() {
    const sender = document.querySelector('#hidden_clipboard_sender');
    if (sender && sender.value) {
        console.log('Sending clipboard to VNC server via hidden element:', sender.value.substring(0, 50) + '...');
        
        // Try multiple ways to access the RFB object
        let rfbObject = null;
        
        // First try the global rfb variable (vnc_lite.html approach)
        if (window.rfb && typeof window.rfb.clipboardPasteFrom === 'function') {
            rfbObject = window.rfb;
        }
        // Fallback to UI.rfb (full noVNC app approach)
        else if (window.UI && window.UI.rfb && typeof window.UI.rfb.clipboardPasteFrom === 'function') {
            rfbObject = window.UI.rfb;
        }
        
        if (rfbObject) {
            rfbObject.clipboardPasteFrom(sender.value);
            console.log('Successfully sent clipboard data via RFB object');
            
            // Automatically trigger paste on the server by sending Ctrl+V
            setTimeout(() => {
                // Send Ctrl+V keyboard combination to the server
                if (typeof rfbObject.sendKey === 'function') {
                    // Send Ctrl key down (using correct keysym values)
                    rfbObject.sendKey(0xffe3, 'ControlLeft', true);  // XK_Control_L down
                    // Send V key down
                    rfbObject.sendKey(0x0076, 'KeyV', true);         // XK_v down  
                    // Send V key up
                    rfbObject.sendKey(0x0076, 'KeyV', false);        // XK_v up
                    // Send Ctrl key up  
                    rfbObject.sendKey(0xffe3, 'ControlLeft', false); // XK_Control_L up
                    
                    console.log('Sent Ctrl+V to server for automatic paste');
                } else {
                    console.error('sendKey method not available on RFB object');
                }
            }, 100); // Small delay to ensure clipboard data is processed first
        } else {
            console.error('RFB object not available or clipboardPasteFrom method not found');
            console.log('Available objects:', {
                'window.rfb': !!window.rfb,
                'window.UI': !!window.UI,
                'window.UI.rfb': !!(window.UI && window.UI.rfb)
            });
        }
    }
}
