// Import prompts from the separate file (if still needed for single-player)
import {geemsPrompts} from './prompts.js';
import MPLib from './mp.js';
// Assuming MPLib is globally available after including mp.js or imported if using modules
// import MPLib from './mp.js'; // Uncomment if using ES6 modules for MPLib

// --- Game State Variables ---
let historyQueue = [];
const MAX_HISTORY_SIZE = 20;
let currentUiJson = null;
let currentNotes = {};
let currentSubjectId = "";
let isExplicitMode = false; // Default mode
let isLoading = false;
let apiKeyLocked = false;
let localGameStateSnapshot = null; // To store local state when viewing remote state
let hiddenAnalysisContent = null; // To store content of gemini_facing_analysis for modal
let hiddenAnalysisContentTweet = null; // To store content of gemini_facing_analysis for modal
let hiddenAnalysisContentNotes = null; // To store content of gemini_facing_analysis for modal

// --- Model Switching State ---
const AVAILABLE_MODELS = [
    "gemini-1.5-pro-latest"
];
let currentModelIndex = 0;

// --- Configuration ---
const MIN_CONTRAST_LIGHTNESS = 0.55;
const LOCAL_STORAGE_KEY = 'geemsGameStateToRestore';
const DEFAULT_HOST_ID = 'geems-default-game-host'; // Define a host ID for players to connect to

// --- DOM Element References ---
const lobbyContainer = document.getElementById('lobby-container');
const gameWrapper = document.getElementById('game-wrapper');
const proposalModal = document.getElementById('proposalModal');
const proposalModalTitle = document.getElementById('proposalModalTitle');
const proposalModalBody = document.getElementById('proposalModalBody');
const proposerName = document.getElementById('proposerName');
const proposalAcceptButton = document.getElementById('proposalAcceptButton');
const proposalDeclineButton = document.getElementById('proposalDeclineButton');
const enterLobbyButton = document.getElementById('enterLobbyButton');
const interstitialMessage = document.getElementById('interstitial-message');
const uiContainer = document.getElementById('ui-elements');
const loadingIndicator = document.getElementById('loading');
const submitButton = document.getElementById('submit-turn');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeySection = document.getElementById('apiKeySection');
const errorDisplay = document.getElementById('error-display');
const modeToggleButton = document.getElementById('modeToggleButton');
const resetGameButton = document.getElementById('resetGameButton');
const clipboardMessage = document.getElementById('clipboardMessage');
const headerBanner = document.getElementById('headerBanner');
const footerBanner = document.getElementById('footerBanner');
// Assume footer exists, get reference to it
const footerElement = document.querySelector('.site-footer');
const h1 = document.querySelector('h1');
let peerListContainer = null; // Will be created dynamically
// Add references for the modal (assuming HTML structure exists)
const analysisModal = document.getElementById('analysisModal'); // e.g., <div id="analysisModal" class="modal" style="display:none;">...</div>
const analysisModalBody = document.getElementById('analysisModalBody'); // e.g., <div id="analysisModalBody"></div> inside the modal
const analysisModalClose = document.getElementById('analysisModalClose'); // e.g., <button id="analysisModalClose">Close</button> inside the modal

// --- Web Audio API Context ---
let audioCtx = null;

// --- Multiplayer State ---
let isDateActive = false;
let currentPartnerId = null;
let amIPlayer1 = false;
let isMyTurn = false;
let partnerActions = null; // To store actions from the other player
let incomingProposal = null; // To store details of a proposal
let isDateExplicit = false; // Is the current date in explicit mode?

const remoteGameStates = new Map(); // Map<peerId, gameState>

// --- Long Press State ---
let pressTimer = null;
let isLongPress = false;
const longPressDuration = 750; // milliseconds

// --- Helper Functions ---

/** Encodes a string using Base64. */
function encodeApiKey(key) {
    try {
        return btoa(key);
    } catch (e) {
        console.error("Error encoding API key:", e);
        return "";
    }
}

/** Decodes a Base64 string. Returns null on error. */
function decodeApiKey(encodedKey) {
    try {
        return atob(encodedKey);
    } catch (e) {
        console.error("Error decoding API key:", e);
        return null;
    }
}
/** Constructs the full prompt for the Gemini API call. */
function constructPrompt(turnData) {
    const {
        isFirstTurn = false,
        playerA_id = null,
        playerB_id = null,
        playerA_actions = null,
        playerB_actions = null,
        playerA_notes = null,
        playerB_notes = null,
        isExplicit = false
    } = turnData;

    const activeAddendum = isExplicit ? `\n\n---\n${geemsPrompts.masturbationModeAddendum}\n---\n` : "";

    if (isFirstTurn) {
        let prompt = geemsPrompts.dating_first_turn;
        prompt = prompt.replace('{{playerA_id}}', playerA_id);
        prompt = prompt.replace('{{playerB_id}}', playerB_id);
        console.log("Generated Dating First Turn Prompt.");
        return prompt;
    }

    // For subsequent turns
    let prompt = geemsPrompts.dating_main;
    prompt += `\n\n---\nPREVIOUS STATE & ACTIONS\n---\n`;
    prompt += `player_input_A: ${JSON.stringify(playerA_actions)}\n`;
    prompt += `previous_notes_A: \`\`\`markdown\n${playerA_notes}\n\`\`\`\n\n`;
    prompt += `player_input_B: ${JSON.stringify(playerB_actions)}\n`;
    prompt += `previous_notes_B: \`\`\`markdown\n${playerB_notes}\n\`\`\`\n`;
    prompt += activeAddendum;
    prompt += `\n--- Generate JSON UI for the next turn for both players ---`;
    console.log("Generated Subsequent Dating Turn Prompt.");
    return prompt;
}

/** Saves the current essential game state to local storage. */
function autoSaveGameState() {
    if (!apiKeyLocked) return;
    if (!currentUiJson || !historyQueue) return;
    const rawApiKey = apiKeyInput.value.trim();
    if (!rawApiKey) return;
    try {
        const stateToSave = {
            encodedApiKey: encodeApiKey(rawApiKey),
            currentUiJson: currentUiJson,
            historyQueue: historyQueue,
            isExplicitMode: isExplicitMode,
            currentModelIndex: currentModelIndex
        };
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stateToSave));
        console.log("Game state auto-saved.");
    } catch (error) {
        console.error("Error during auto-save:", error);
        showError("Error auto-saving game state.");
    }
}

/** Initializes the AudioContext if it doesn't exist. */
function initAudioContext() {
    if (!audioCtx) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log("AudioContext initialized.");
            if (audioCtx.state === 'suspended') audioCtx.resume();
        } catch (e) {
            console.error("Web Audio API not supported.", e);
            showError("Audio alerts not supported.");
        }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(err => console.error("Error resuming audio context:", err));
}

/** Plays the turn alert sound. */
function playTurnAlertSound() {
    initAudioContext();
    if (!audioCtx || audioCtx.state !== 'running') return;
    const now = audioCtx.currentTime, totalDuration = 1.0;
    const fogOsc = audioCtx.createOscillator(), fogGain = audioCtx.createGain();
    fogOsc.type = 'sawtooth';
    fogOsc.frequency.setValueAtTime(80, now);
    fogGain.gain.setValueAtTime(0.3, now);
    fogGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
    fogOsc.connect(fogGain);
    fogGain.connect(audioCtx.destination);
    fogOsc.start(now);
    fogOsc.stop(now + 0.5);
    const beepOsc = audioCtx.createOscillator(), beepGain = audioCtx.createGain();
    beepOsc.type = 'square';
    beepOsc.frequency.setValueAtTime(440, now + 0.6);
    beepGain.gain.setValueAtTime(0, now + 0.6);
    beepGain.gain.linearRampToValueAtTime(0.2, now + 0.65);
    beepGain.gain.setValueAtTime(0.2, now + 0.75);
    beepGain.gain.linearRampToValueAtTime(0, now + 0.8);
    beepOsc.frequency.setValueAtTime(523, now + 0.85);
    beepGain.gain.setValueAtTime(0, now + 0.85);
    beepGain.gain.linearRampToValueAtTime(0.2, now + 0.9);
    beepGain.gain.setValueAtTime(0.2, now + totalDuration - 0.05);
    beepGain.gain.linearRampToValueAtTime(0.001, now + totalDuration);
    beepOsc.connect(beepGain);
    beepGain.connect(audioCtx.destination);
    beepOsc.start(now + 0.6);
    beepOsc.stop(now + totalDuration);
    console.log("Playing turn alert sound.");
}

/** Updates the history queue. */
function updateHistoryQueue(playerActionsJson) {
    if (currentUiJson) {
        const previousTurnData = {ui: JSON.stringify(currentUiJson), actions: playerActionsJson || "{}"};
        const isDuplicate = historyQueue.some(item => JSON.stringify(item) === JSON.stringify(previousTurnData));
        if (isDuplicate) {
            console.log("Duplicate turn data detected, not adding to history queue.");
            return;
        }
        if (historyQueue.length >= MAX_HISTORY_SIZE) historyQueue.shift();
        historyQueue.push(previousTurnData);
        console.log(`History Queue size: ${historyQueue.length}/${MAX_HISTORY_SIZE}`);
    }
}

/** Gets the current game state for sending to peers. */
function getCurrentGameState() {
    // Basic example: Send current UI JSON and history.
    // Adapt this to include *actual* relevant game variables.
    return {
        currentUiJson: currentUiJson,
        historyQueue: historyQueue,
        currentSubjectId: currentSubjectId,
        // Add other critical state variables here, e.g., player inventory, world state etc.
        // currentNotes: currentNotes // Maybe too large? Decide what's needed.
    };
}

/** Loads a game state received from a peer. */
function loadGameState(newState, sourcePeerId = null) {
    if (!newState) {
        console.error("Attempted to load null game state.");
        return;
    }
    console.log(`Loading game state${sourcePeerId ? ` from peer ${sourcePeerId.slice(-6)}` : ''}`);

    // Before loading remote state, save the current local state
    saveLocalState();

    // Basic example: Restore UI and history.
    // Adapt this to handle your game's specific state restoration.
    currentUiJson = newState.currentUiJson || null;
    historyQueue = newState.historyQueue || [];
    currentSubjectId = newState.currentSubjectId || "Peer"; // Maybe use peer's subject ID?

    // Render the loaded UI
    if (currentUiJson) {
        renderUI(currentUiJson);
        console.log("Loaded game state UI rendered.");
        // Disable submit turn button when viewing remote state?
        submitButton.disabled = false; // Disable submit when viewing remote state
        showNotification(`Viewing ${sourcePeerId ? sourcePeerId.slice(-6) : 'remote'} state. Click your icon to return.`, 'info', 5000);
    } else {
        showError("Loaded game state is missing UI data.");
    }
    updatePeerListUI(); // Highlight the peer being viewed
    highlightPeerIcon(sourcePeerId); // Explicitly highlight
}

/** Saves the current local game state snapshot. */
function saveLocalState() {
    console.log("Saving local game state snapshot.");
    localGameStateSnapshot = {
        currentUiJson: JSON.parse(JSON.stringify(currentUiJson)), // Deep copy
        historyQueue: JSON.parse(JSON.stringify(historyQueue)),   // Deep copy
        currentSubjectId: currentSubjectId
    };
}

/** Restores the previously saved local game state. */
function restoreLocalState() {
    if (localGameStateSnapshot) {
        console.log("Restoring local game state.");
        currentUiJson = localGameStateSnapshot.currentUiJson;
        historyQueue = localGameStateSnapshot.historyQueue;
        currentSubjectId = localGameStateSnapshot.currentSubjectId;
        localGameStateSnapshot = null; // Clear the snapshot

        if (currentUiJson) {
            renderUI(currentUiJson);
            console.log("Restored local game state UI rendered.");
            submitButton.disabled = isLoading || !apiKeyLocked; // Re-enable submit button
            updatePeerListUI(); // Clear highlights
            showNotification("Returned to your game state.", "info", 2000);
        } else {
            showError("Error restoring local game state: UI data missing.");
            // Might need a more robust recovery here
        }
    } else {
        console.warn("No local game state snapshot to restore.");
    }
}


/** Processes the successful response from the Gemini API. */
function processSuccessfulResponse(responseJson, turnData) {
    if (!apiKeyLocked) {
        apiKeyLocked = true;
        if (apiKeySection) apiKeySection.style.display = 'none';
        resetGameButton.disabled = false;
    }

    if (isDateActive) {
        // Two-player date response
        const { playerA_ui, playerB_ui } = responseJson;

        if (!playerA_ui || !playerB_ui) {
            showError("Received invalid split-UI response from AI.");
            isMyTurn = true; // Allow P1 to try again
            updateTurnStatusDisplay();
            return;
        }

        // Player 1 renders their UI and sends Player 2's UI to them
        currentUiJson = playerA_ui;
        renderUI(playerA_ui);
        playTurnAlertSound();

        MPLib.sendDirect(currentPartnerId, { type: 'new_turn_ui', payload: playerB_ui });

    } else {
        // Single-player response
        currentUiJson = responseJson;
        renderUI(currentUiJson);
        playTurnAlertSound();
        autoSaveGameState(); // Only autosave single-player games for now
    }

    // This is a good place for a potential broadcast, but the logic needs to be
    // adapted for the dating sim context (e.g., broadcasting profiles/status)
    // broadcastGameState();
}

/** Broadcasts the current game state to all connected peers */
function broadcastGameState() {
    if (!MPLib || MPLib.getConnections().size === 0) return; // Check if MPLib is available and peers connected

    const stateToSend = getCurrentGameState();
    console.log("Broadcasting game state update to peers.");
    MPLib.broadcast({
        type: 'game_state_update',
        payload: stateToSend
    });
}

/** Fetches the next turn's UI data from the Gemini API. */
async function fetchTurnData(turnData) {
    // For single-player mode, maintain history queue. For dates, state is passed explicitly.
    if (!isDateActive) {
        updateHistoryQueue(turnData.playerA_actions);
    }

    console.log("fetchTurnData called with turnData:", turnData);
    initAudioContext();
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showError("Please enter API Key");
        setLoading(false);
        if (apiKeySection.style.display === 'none') apiKeySection.style.display = 'block';
        return;
    }

    setLoading(true);
    hideError();
    const initialMsgEl = document.getElementById('initial-message');
    if (initialMsgEl) initialMsgEl.style.display = 'none';

    let success = false;
    let attempts = 0;
    const maxAttempts = AVAILABLE_MODELS.length * 2 + 1;
    let currentAttemptConsecutiveErrors = 0;

    while (!success && attempts < maxAttempts) {
        attempts++;
        const currentModel = AVAILABLE_MODELS[currentModelIndex];
        console.log(`Attempt ${attempts}/${maxAttempts}: Trying model ${currentModel}`);
        try {
            const fullPrompt = constructPrompt(turnData);
            console.log(`Sending Prompt to ${currentModel}`);
            const jsonStringResponse = await callRealGeminiAPI(apiKey, fullPrompt, currentModel);
            const responseJson = JSON.parse(jsonStringResponse);
            console.log(`Parsed API response from ${currentModel}.`);
            processSuccessfulResponse(responseJson, turnData);
            success = true;
            currentAttemptConsecutiveErrors = 0;
        } catch (error) {
            console.error(`Error with model ${currentModel} (Attempt ${attempts}):`, error);
            currentAttemptConsecutiveErrors++;
            const isQuotaError = error.message.includes('429') || /quota exceeded|resource.*exhausted/i.test(error.message);
            const shouldSwitch = isQuotaError || currentAttemptConsecutiveErrors >= 2;
            if (shouldSwitch && AVAILABLE_MODELS.length > 1) {
                const oldModel = AVAILABLE_MODELS[currentModelIndex];
                currentModelIndex = (currentModelIndex + 1) % AVAILABLE_MODELS.length;
                const newModel = AVAILABLE_MODELS[currentModelIndex];
                console.warn(`Switching model from ${oldModel} to ${newModel} due to ${isQuotaError ? 'quota/resource error' : '2 errors'}.`);
                showError(`Experiencing issues with ${oldModel}. Trying ${newModel}... (Attempt ${attempts + 1})`);
                currentAttemptConsecutiveErrors = 0;
            } else if (attempts < maxAttempts) {
                showError(`Temporary issue with ${currentModel}. Retrying... (Attempt ${attempts + 1})`);
            }
            if (!success && attempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 750));
        }
    }
    if (!success) {
        console.error(`Failed after ${maxAttempts} attempts.`);
        showError(`Failed to get response after ${maxAttempts} attempts. Check API key, network, or try later.`);
    } else {
        hideError();
        window.scrollTo({top: 0, behavior: 'smooth'});
    }
    setLoading(false);
}

/** Calls the real Google AI (Gemini) API. */
async function callRealGeminiAPI(apiKey, promptText, modelName) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const requestBody = {
        contents: [{parts: [{text: promptText}]}],
        generationConfig: {temperature: 1.0, response_mime_type: "application/json"},
        safetySettings: [{
            "category": "HARM_CATEGORY_HARASSMENT",
            "threshold": "BLOCK_NONE"
        }, {
            "category": "HARM_CATEGORY_HATE_SPEECH",
            "threshold": "BLOCK_NONE"
        }, {
            "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "threshold": "BLOCK_NONE"
        }, {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"}]
    };
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
        let errorBody = `API request failed (${response.status})`;
        try {
            const errorJson = await response.json();
            errorBody += `: ${JSON.stringify(errorJson.error || errorJson)}`;
        } catch (e) {
            try {
                errorBody += `: ${await response.text()}`;
            } catch (e2) {
            }
        }
        console.error("API Error:", errorBody);
        throw new Error(errorBody);
    }
    const responseData = await response.json();
    if (responseData.promptFeedback && responseData.promptFeedback.blockReason) throw new Error(`Request blocked by API. Reason: ${responseData.promptFeedback.blockReason}. Details: ${JSON.stringify(responseData.promptFeedback.safetyRatings || 'N/A')}`);
    if (!responseData.candidates || responseData.candidates.length === 0) {
        if (typeof responseData === 'string') {
            try {
                JSON.parse(responseData);
                return responseData.trim();
            } catch (e) {
                throw new Error('No candidates, response not valid JSON.');
            }
        }
        throw new Error('No candidates or unexpected API response.');
    }
    const candidate = responseData.candidates[0];
    if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
        if (candidate.finishReason === "SAFETY") throw new Error(`API call finished due to SAFETY. Ratings: ${JSON.stringify(candidate.safetyRatings || 'N/A')}`); else if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) throw new Error(`API call finished unexpectedly (${candidate.finishReason}) and no content.`);
    }
    if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
        let generatedText = candidate.content.parts[0].text;
        const jsonMatch = generatedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch && jsonMatch[1]) generatedText = jsonMatch[1];
        let trimmedText = generatedText.trim();
        try {
            JSON.parse(trimmedText);
            return trimmedText;
        } catch (e) {
            throw new Error(`Invalid JSON from API. Snippet: ${trimmedText.substring(0, 200)}...`);
        }
    } else throw new Error('API candidate generated but no content parts.');
}

/** Renders the UI elements based on the JSON array. */
function renderUI(uiJsonArray) {
    console.log("renderUI started.");
    hiddenAnalysisContent = null; // Reset hidden content before rendering new UI
    const initialMsgElementRef = document.getElementById('initial-message');
    uiContainer.innerHTML = '';
    if (!Array.isArray(uiJsonArray)) {
        console.error("Invalid UI data: Expected an array.", uiJsonArray);
        showError("Invalid UI data format from API.");
        if (initialMsgElementRef) {
            const clonedInitialMsg = initialMsgElementRef.cloneNode(true);
            clonedInitialMsg.style.display = 'block';
            uiContainer.appendChild(clonedInitialMsg);
        }
        return;
    }
    uiJsonArray.forEach((element, index) => {
        renderSingleElement(element, index);
    });
    const imageElement = uiContainer.querySelector('.geems-image-container');
    const analysisToggleContainer = uiContainer.querySelector('.analysis-toggle-container');
    if (imageElement && analysisToggleContainer) {
        uiContainer.insertBefore(analysisToggleContainer, imageElement.nextSibling || null);
    }
    const tweetElement = document.getElementById('tweet-element-wrapper');
    if (analysisToggleContainer && tweetElement) {
        uiContainer.insertBefore(tweetElement, analysisToggleContainer.nextSibling || null);
    } else if (imageElement && tweetElement) {
        uiContainer.insertBefore(tweetElement, imageElement.nextSibling || null);
    }
}

/** Renders a single UI element. */
function renderSingleElement(element, index) {
    // --- MODIFICATION START: Check for gemini_facing_analysis ---
    // If it's the gemini_facing_analysis text element, store its content and skip rendering.
    if (element.type === 'text' && element.name?.includes('gemini_facing_analysis')) {
        hiddenAnalysisContent = element.text || element.value || '';
        console.log("Stored hidden 'gemini_facing_analysis' content.");
        return; // Do not render this element to the main UI
    }
    if (element.name?.includes('tweet')) {
        hiddenAnalysisContentTweet = element.text || element.value || '';
        console.log("Stored hidden 'tweet' content.");
        return; // Do not render this element to the main UI
    }
    if (element.name?.includes('notes')) {
        hiddenAnalysisContentNotes = element.value || '';
        console.log("Stored hidden 'gemini_facing_analysis' content.");
        return; // Do not render this element to the main UI
    }
    // --- MODIFICATION END ---

    const wrapper = document.createElement('div');
    wrapper.className = 'geems-element';
    if (element.voice) wrapper.classList.add(`voice-${element.voice}`);
    let adjustedColor = null;
    if (element.color && isValidHexColor(element.color)) {
        adjustedColor = adjustColorForContrast(element.color);
        wrapper.style.borderLeftColor = adjustedColor;
        if (wrapper.classList.contains('analysis-toggle-container')) wrapper.style.borderColor = adjustedColor;
    } else {
        wrapper.style.borderLeftColor = 'transparent';
    }
    try {
        switch (element.type) {
            case 'image':
                renderImage(wrapper, element, adjustedColor);
                break;
            case 'header': // Alias for text
            case 'text':
                renderText(wrapper, element, adjustedColor);
                break;
            case 'input_text': // Alias for textfield
            case 'textfield':
                renderTextField(wrapper, element, adjustedColor);
                break;
            case 'checkbox':
                renderCheckbox(wrapper, element, adjustedColor);
                break;
            case 'slider':
                renderSlider(wrapper, element, adjustedColor);
                break;
            case 'input_dropdown': // Alias for radio
            case 'input_radio_probe': // Alias for radio
            case 'radio_group': // Alias for radio
            case 'radio':
                renderRadio(wrapper, element, adjustedColor);
                break;
            case 'hidden':
                if (element.name === 'notes') {
                    // Create a hidden input to store the notes value in the DOM
                    const hiddenInput = document.createElement('input');
                    hiddenInput.type = 'hidden';
                    hiddenInput.name = 'notes';
                    hiddenInput.value = element.value || '';
                    wrapper.appendChild(hiddenInput);
                } else if (element.name === 'subjectId') {
                    currentSubjectId = element.value || "";
                }
                // Don't return here, append the wrapper so the hidden input is in the DOM
                break;
            default:
                console.warn("Unknown element type:", element.type, element);
                wrapper.textContent = `Unknown element type: ${element.type}`;
                wrapper.style.color = 'red';
        }
        uiContainer.appendChild(wrapper);
    } catch (renderError) {
        console.error(`Error rendering element ${index} (type: ${element.type}, name: ${element.name}):`, renderError, element);
        const errorWrapper = document.createElement('div');
        errorWrapper.className = 'geems-element error-message';
        errorWrapper.textContent = `Error rendering element: ${element.name || element.type}. Check console.`;
        uiContainer.appendChild(errorWrapper);
    }
}

// --- UI Element Rendering Functions ---
function renderImage(wrapper, element, adjustedColor) {
    wrapper.classList.add('geems-image-container');
    wrapper.classList.remove('geems-element');
    wrapper.style.borderLeftColor = 'transparent';
    const img = document.createElement('img');
    img.className = 'geems-image';
    const imagePrompt = element.value || 'abstract image';
    const randomSeed = Math.floor(Math.random() * 65536);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?nologo=true&safe=false&seed=${randomSeed}`;
    img.src = imageUrl;
    img.alt = element.label || `Image: ${imagePrompt.substring(0, 50)}...`;
    img.onerror = () => {
        console.warn(`Failed to load image: ${imageUrl}`);
        img.src = `https://placehold.co/600x400/e0e7ff/4f46e5?text=Image+Load+Error`;
        img.alt = `Error loading image: ${imagePrompt.substring(0, 50)}...`;
    };
    wrapper.appendChild(img);
    if (element.label) {
        const labelDiv = document.createElement('div');
        labelDiv.className = 'geems-label text-center font-semibold mt-2';
        if (adjustedColor) labelDiv.style.color = adjustedColor;
        labelDiv.textContent = element.label;
        wrapper.appendChild(labelDiv);
    }
    const promptText = document.createElement('p');
    promptText.className = 'geems-image-prompt';
    promptText.textContent = imagePrompt;
    wrapper.appendChild(promptText);
}

function renderText(wrapper, element, adjustedColor) {
    const textContent = element.text || element.value || '';
    const useLabel = element.label && !['narrative', 'divine_wisdom', 'player_facing_analysis'].some(namePart => element.name?.includes(namePart)); /* Removed gemini_facing_analysis from here as it's handled earlier */
    if (useLabel) {
        const label = document.createElement('label');
        label.className = 'geems-label';
        if (adjustedColor) label.style.color = adjustedColor;
        label.textContent = element.label;
        wrapper.appendChild(label);
    }
    const textElement = document.createElement('div');
    textElement.className = 'geems-text';
    textElement.innerHTML = textContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim()}</pre>`).replace(/\n/g, '<br>');
    wrapper.appendChild(textElement);
}

function renderTextField(wrapper, element, adjustedColor) {
    const label = document.createElement('label');
    label.className = 'geems-label';
    label.textContent = element.label || element.name;
    label.htmlFor = element.name;
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);
    const input = document.createElement('textarea');
    input.className = 'geems-textarea';
    input.id = element.name;
    input.name = element.name;
    input.rows = 4;
    input.value = element.value || '';
    input.placeholder = element.placeholder || 'Type response...';
    input.dataset.elementType = 'textfield';
    wrapper.appendChild(input);
}

function renderCheckbox(wrapper, element, adjustedColor) {
    wrapper.classList.remove('geems-element');
    wrapper.style.borderLeftColor = 'transparent';
    wrapper.style.padding = '0';
    wrapper.style.marginBottom = '0.75rem';
    const optionDiv = document.createElement('div');
    optionDiv.className = 'geems-checkbox-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = element.name;
    input.name = element.name;
    input.checked = element.value === true || String(element.value).toLowerCase() === 'true';
    input.dataset.elementType = 'checkbox';
    if (adjustedColor) input.style.accentColor = adjustedColor;
    const label = document.createElement('label');
    label.htmlFor = element.name;
    label.textContent = element.label || element.name;
    label.className = "flex-grow cursor-pointer";
    optionDiv.appendChild(input);
    optionDiv.appendChild(label);
    wrapper.appendChild(optionDiv);
}

function renderSlider(wrapper, element, adjustedColor) {
    const label = document.createElement('label');
    label.className = 'geems-label';
    label.textContent = element.label || element.name;
    label.htmlFor = element.name;
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);
    const sliderContainer = document.createElement('div');
    sliderContainer.className = 'flex items-center space-x-4 mt-2';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'geems-slider flex-grow';
    input.id = element.name;
    input.name = element.name;
    const min = parseFloat(element.min) || 0;
    const max = parseFloat(element.max) || 10;
    input.min = min;
    input.max = max;
    input.step = element.step || 1;
    const defaultValue = parseFloat(element.value);
    input.value = isNaN(defaultValue) ? (min + max) / 2 : Math.max(min, Math.min(max, defaultValue));
    input.dataset.elementType = 'slider';
    if (adjustedColor) {
        input.style.accentColor = adjustedColor;
        input.style.setProperty('--slider-thumb-color', adjustedColor);
        input.setAttribute('style', `${input.getAttribute('style') || ''} --slider-thumb-color: ${adjustedColor};`);
    }
    const valueDisplay = document.createElement('span');
    valueDisplay.className = `geems-slider-value-display font-medium w-auto text-right`;
    valueDisplay.textContent = input.value;
    if (adjustedColor) valueDisplay.style.color = adjustedColor;
    input.oninput = () => {
        valueDisplay.textContent = input.value;
    };
    sliderContainer.appendChild(input);
    sliderContainer.appendChild(valueDisplay);
    wrapper.appendChild(sliderContainer);
}

function renderRadio(wrapper, element, adjustedColor) {
    wrapper.classList.remove('geems-element');
    wrapper.style.borderLeftColor = 'transparent';
    wrapper.style.padding = '0';
    wrapper.style.marginBottom = '0.75rem';
    const label = document.createElement('label');
    label.className = 'geems-label block mb-2';
    label.textContent = element.label || element.name;
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);
    let options = [];
    let defaultValue = null;
    let optionsSource = element.options || element.value;
    try {
        if (typeof optionsSource === 'string') {
            try {
                optionsSource = JSON.parse(optionsSource);
            } catch (e) {
                optionsSource = [{label: optionsSource, value: optionsSource}];
            }
        }
        if (Array.isArray(optionsSource)) {
            options = optionsSource.map(opt => {
                let currentLabel = '', currentValue = '', isDefault = false;
                if (typeof opt === 'object' && opt !== null && opt.value !== undefined) {
                    currentValue = String(opt.value);
                    currentLabel = opt.label !== undefined ? String(opt.label) : currentValue;
                    if (currentLabel.startsWith('*')) {
                        defaultValue = currentValue;
                        currentLabel = currentLabel.substring(1);
                        isDefault = true;
                    }
                } else {
                    currentValue = String(opt);
                    currentLabel = currentValue;
                    if (currentLabel.startsWith('*')) {
                        defaultValue = currentValue.substring(1);
                        currentValue = defaultValue;
                        currentLabel = defaultValue;
                        isDefault = true;
                    }
                }
                return {value: currentValue, label: currentLabel, isDefault: isDefault};
            }).filter(opt => opt !== null);
            if (defaultValue === null && element.value && typeof element.value === 'string') {
                let isValueSimpleString = true;
                try {
                    if (Array.isArray(JSON.parse(element.value))) isValueSimpleString = false;
                } catch (e) {
                }
                if (isValueSimpleString) {
                    const directValueMatch = options.find(opt => opt.value === element.value);
                    if (directValueMatch) defaultValue = directValueMatch.value;
                }
            }
        }
    } catch (e) {
        console.error("Failed radio options:", element.name, e);
    }
    if (defaultValue === null && options.length > 0) defaultValue = options[0].value;
    if (options.length > 0) {
        options.forEach((option, index) => {
            const optionDiv = document.createElement('div');
            optionDiv.className = 'geems-radio-option';
            const input = document.createElement('input');
            input.type = 'radio';
            const inputId = `${element.name}_${index}`;
            input.id = inputId;
            input.name = element.name;
            input.value = option.value;
            input.checked = (option.value === defaultValue);
            input.dataset.elementType = 'radio';
            if (adjustedColor) input.style.accentColor = adjustedColor;
            const optionLabel = document.createElement('label');
            optionLabel.htmlFor = inputId;
            optionLabel.textContent = option.label;
            optionLabel.className = "flex-grow cursor-pointer";
            optionDiv.appendChild(input);
            optionDiv.appendChild(optionLabel);
            wrapper.appendChild(optionDiv);
        });
    } else {
        wrapper.innerHTML += `<p class="text-sm text-red-600">Error: No valid options for radio group '${element.name}'.</p>`;
    }
}

// --- Utility Functions ---
function collectInputState() {
    const inputs = {};
    // Collect visible inputs
    uiContainer.querySelectorAll('[data-element-type]').forEach(el => {
        const name = el.name;
        if (!name) return;
        const type = el.dataset.elementType;
        switch (type) {
            case 'textfield':
                inputs[name] = el.value;
                break;
            case 'checkbox':
                inputs[name] = el.checked;
                break;
            case 'slider':
                inputs[name] = parseFloat(el.value);
                break;
            case 'radio':
                if (el.checked) inputs[name] = el.value;
                break;
        }
    });
    // Specifically find and add the hidden 'notes' field for the current player
    const notesInput = uiContainer.querySelector('input[type="hidden"][name="notes"]');
    if (notesInput) {
        inputs['notes'] = notesInput.value;
    }

    inputs['turn'] = historyQueue.length + 1; // Still useful for single player
    return JSON.stringify(inputs);
}

function setLoading(loading) {
    isLoading = loading;
    loadingIndicator.style.display = loading ? 'flex' : 'none';
    const keyPresent = apiKeyInput.value.trim().length > 0;
    submitButton.disabled = loading || !(apiKeyLocked || keyPresent);
    modeToggleButton.disabled = loading;
    resetGameButton.disabled = loading || !apiKeyLocked;
    uiContainer.querySelectorAll('input, textarea, button, .analysis-toggle-container, .geems-radio-option, .geems-checkbox-option').forEach(el => {
        if (el.id !== 'submit-turn' && el.id !== 'modeToggleButton' && el.id !== 'resetGameButton') {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON') el.disabled = loading;
            if (el.classList.contains('geems-radio-option') || el.classList.contains('geems-checkbox-option') || el.classList.contains('analysis-toggle-container') || el.closest('.geems-slider-container')) {
                el.style.opacity = loading ? 0.5 : 1.0;
                el.style.pointerEvents = loading ? 'none' : 'auto';
                el.querySelectorAll('.geems-slider').forEach(slider => slider.disabled = loading);
            }
        }
    });
}

function showError(message) {
    errorDisplay.textContent = message;
    errorDisplay.style.display = 'block';
}

function hideError() {
    errorDisplay.textContent = '';
    errorDisplay.style.display = 'none';
}

function isValidHexColor(hex) {
    return typeof hex === 'string' && /^#[0-9A-F]{6}$/i.test(hex);
}

function adjustColorForContrast(hex) {
    if (!isValidHexColor(hex)) return hex;
    let r = parseInt(hex.substring(1, 3), 16), g = parseInt(hex.substring(3, 5), 16),
        b = parseInt(hex.substring(5, 7), 16);
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            case b:
                h = (r - g) / d + 4;
                break;
        }
        h /= 6;
    }
    if (l > MIN_CONTRAST_LIGHTNESS) {
        l = MIN_CONTRAST_LIGHTNESS * 0.9;
        let r1, g1, b1;
        if (s === 0) r1 = g1 = b1 = l; else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r1 = hue2rgb(p, q, h + 1 / 3);
            g1 = hue2rgb(p, q, h);
            b1 = hue2rgb(p, q, h - 1 / 3);
        }
        const toHex = x => {
            const hexVal = Math.round(x * 255).toString(16);
            return hexVal.length === 1 ? '0' + hexVal : hexVal;
        };
        return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
    }
    return hex;
}

function showClipboardMessage(message, isError = false) {
    clipboardMessage.textContent = message;
    clipboardMessage.style.color = isError ? '#dc2626' : '#16a34a';
    setTimeout(() => {
        clipboardMessage.textContent = '';
    }, 3000);
}

function updateModeButtonVisuals() {
    if (isExplicitMode) {
        modeToggleButton.textContent = '18+ Mode: On';
        modeToggleButton.classList.remove('standard-mode');
    } else {
        modeToggleButton.textContent = '18+ Mode: Off';
        modeToggleButton.classList.add('standard-mode');
    }
}

function setDynamicImages() {
    const headerSeed = Math.floor(Math.random() * 65536), footerSeed = Math.floor(Math.random() * 65536);
    const headerPrompt = "wide cinematic vivid colorful abstract emotional landscape brainwaves",
        footerPrompt = "wide abstract colorful digital roots network connections";
    if (headerBanner) {
        headerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(headerPrompt)}?width=1200&height=200&seed=${headerSeed}&nologo=true&safe=false`;
        headerBanner.alt = headerPrompt;
    }
    if (footerBanner) {
        footerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(footerPrompt)}?width=1200&height=100&seed=${footerSeed}&nologo=true&safe=false`;
        footerBanner.alt = footerPrompt;
    }
}

// --- Modal Functions ---
/** Displays the modal with the hidden analysis content. */
function showAnalysisModal() {
    // Check if modal elements exist
    if (!analysisModal || !analysisModalBody) {
        console.error("Analysis modal elements not found in the DOM.");
        showError("Cannot display analysis: Modal elements missing.");
        return;
    }

    if (hiddenAnalysisContent) {
        // Basic HTML rendering (similar to renderText)
        analysisModalBody.innerHTML = (hiddenAnalysisContentTweet + "\n\n" + hiddenAnalysisContent + "\n\nSystem notes: " + hiddenAnalysisContentNotes)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold
            .replace(/\*(.*?)\*/g, '<em>$1</em>')       // Italics
            .replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim()}</pre>`) // Code blocks
            .replace(/\n/g, '<br>'); // Newlines
    } else {
        analysisModalBody.innerHTML = '<p>No analysis content available for this turn.</p>';
    }
    analysisModal.style.display = 'block'; // Or 'flex', depending on your CSS
}

/** Hides the analysis modal. */
function hideAnalysisModal() {
    if (analysisModal) {
        analysisModal.style.display = 'none';
    }
}

// --- Multiplayer Functions ---

/** Shows a basic notification */
function showNotification(message, type = 'info', duration = 4000) {
    // Use your existing showClipboardMessage or create a dedicated notification area
    console.log(`[Notification-${type}] ${message}`);
    showClipboardMessage(message, type === 'error' || type === 'warn');
    // If you have a dedicated notification area:
    // const notificationArea = document.getElementById('notification-area');
    // if(notificationArea) { ... create and append element ... }
}


/** Updates the peer list UI in the footer */
function updatePeerListUI() {
    if (!peerListContainer) return; // Check if container exists
    peerListContainer.innerHTML = ''; // Clear previous icons

    const peers = MPLib.getConnections ? Array.from(MPLib.getConnections().keys()) : [];
    const localId = MPLib.getLocalPeerId ? MPLib.getLocalPeerId() : null;
    const hostId = MPLib.getHostPeerId ? MPLib.getHostPeerId() : null;
    const isViewingRemote = localGameStateSnapshot !== null;

    // Add local player icon
    if (localId) {
        const localIcon = createPeerIcon(localId, 'You', true, localId === hostId); // isSelf=true, isHost=isHost
        localIcon.onclick = () => {
            if (isViewingRemote) {
                console.log("Clicked local icon - restoring local state.");
                restoreLocalState();
                // Submit button state is handled within restoreLocalState
                // Highlight is cleared within restoreLocalState calling this function again
            } else {
                console.log("Clicked local icon - already viewing local state.");
            }
        };
        peerListContainer.appendChild(localIcon);
    }

    // Add remote peer icons
    peers.forEach(peerId => {
        if (peerId !== localId) { // Don't add self again
            const conn = MPLib.getConnections().get(peerId);
            // Check for valid connection object (MPLib might store 'connecting' string temporarily)
            if (conn && typeof conn === 'object' && conn.open) { // Ensure it's an open DataConnection
                const isPeerHost = peerId === hostId;
                const peerIcon = createPeerIcon(peerId, peerId.slice(-6), false, isPeerHost);
                peerIcon.onclick = () => {
                    console.log(`Clicked remote peer icon: ${peerId.slice(-6)}`);
                    // Request game state from this peer
                    console.log(`Requesting game state from ${peerId.slice(-6)}...`);
                    MPLib.sendDirect(peerId, {type: 'request_game_state'});
                    showNotification(`Requesting state from ${peerId.slice(-6)}...`, 'info', 2000);
                    // Highlight this peer (will be updated fully when state arrives)
                    highlightPeerIcon(peerId); // Indicate attempt to view
                    // submitButton.disabled = true; // Handled in loadGameState
                }
                peerListContainer.appendChild(peerIcon);

            } else {
                console.log(`Skipping peer icon for ${peerId.slice(-6)} - connection not fully established or is invalid.`);
                // Optionally add a placeholder icon for connecting peers
            }
        }
    });


    // Highlight the peer whose state is currently being viewed
    // Highlighting is now mainly handled by calls to highlightPeerIcon when clicking or receiving state.
    // Ensure no highlights if viewing local state
    if (!isViewingRemote) {
        highlightPeerIcon(null); // Clear highlights if viewing local
    }
}

/** Creates a single peer icon element */
function createPeerIcon(peerId, labelText, isSelf, isHost) {
    const iconWrapper = document.createElement('div');
    iconWrapper.className = 'peer-icon-wrapper tooltip';
    iconWrapper.dataset.peerId = peerId;

    const icon = document.createElement('span');
    icon.className = 'peer-icon';
    icon.style.backgroundColor = isSelf ? '#4f46e5' : '#71717a'; // Blue for self, gray for others
    if (isHost) {
        icon.style.borderColor = '#facc15'; // Yellow border for host
        icon.style.borderWidth = '2px';
        icon.style.borderStyle = 'solid';
    }
    // Add simple initial/icon, e.g., first letter of label
    icon.textContent = labelText.slice(-4).toUpperCase();

    // Tooltip text
    const tooltipText = document.createElement('span');
    tooltipText.className = 'tooltiptext';
    tooltipText.textContent = `${labelText}${isHost ? ' (Host)' : ''} - ${peerId}`;

    iconWrapper.appendChild(icon);
    iconWrapper.appendChild(tooltipText);

    return iconWrapper;
}

/** Highlights a specific peer icon */
function highlightPeerIcon(peerIdToHighlight) {
    if (!peerListContainer) return;
    peerListContainer.querySelectorAll('.peer-icon-wrapper').forEach(icon => {
        if (icon.dataset.peerId === peerIdToHighlight) {
            icon.classList.add('viewing');
            // Ensure self icon isn't highlighted if viewing remote
            if (peerIdToHighlight !== MPLib.getLocalPeerId()) {
                const selfIcon = peerListContainer.querySelector(`.peer-icon-wrapper[data-peer-id="${MPLib.getLocalPeerId()}"]`);
                if (selfIcon) selfIcon.classList.remove('viewing');
            }
        } else {
            icon.classList.remove('viewing');
        }
    });
    // Ensure local icon is highlighted if no remote peer is specified (i.e., back to local view)
    if (peerIdToHighlight === null && MPLib.getLocalPeerId()) {
        const selfIcon = peerListContainer.querySelector(`.peer-icon-wrapper[data-peer-id="${MPLib.getLocalPeerId()}"]`);
        if (selfIcon) selfIcon.classList.add('viewing');
    }
}

/** Add CSS for Peer Icons and Tooltips (inject or add to styles.css) */
function addPeerIconStyles() {
    const styleId = 'peer-icon-styles';
    if (document.getElementById(styleId)) return; // Avoid adding multiple times

    const css = `
        .peer-list-container {
            display: flex;
            gap: 0.75rem; /* 12px */
            padding: 0.5rem 1rem; /* 8px 16px */
            justify-content: center;
            align-items: center;
            background-color: rgba(255, 255, 255, 0.1); /* Slightly transparent background */
            border-top: 1px solid rgba(209, 213, 219, 0.5); /* Light border */
            margin-top: 1rem; /* Space above peer list */
            flex-wrap: wrap; /* Allow wrapping on small screens */
        }
        .peer-icon-wrapper {
            position: relative;
            display: inline-block;
        }
        .peer-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.5rem; /* 40px */
            height: 2.5rem; /* 40px */
            border-radius: 50%;
            color: white;
            font-weight: bold;
            font-size: 1rem; /* 16px */
            cursor: pointer;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
            box-sizing: border-box; /* Include border in size */
            user-select: none; /* Prevent text selection */
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
        }
        .peer-icon-wrapper:hover .peer-icon {
            transform: scale(1.1);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
        }
        /* Highlight style for viewing peer/self */
        .peer-icon-wrapper.viewing .peer-icon {
             /* Use a distinct outline or shadow to indicate viewing */
             outline: 3px solid #a78bfa; /* Purple outline */
             outline-offset: 2px;
             box-shadow: 0 0 10px rgba(167, 139, 250, 0.7); /* Optional glow */
             /* transform: scale(1.05); // Can conflict with hover */
        }
        /* Tooltip styles */
        .tooltip .tooltiptext {
            visibility: hidden;
            width: max-content; /* Adjust width based on content */
            max-width: 200px; /* Max width */
            background-color: #555;
            color: #fff;
            text-align: center;
            border-radius: 6px;
            padding: 5px 8px;
            position: absolute;
            z-index: 10;
            bottom: 135%; /* Position above the icon */
            left: 50%;
            transform: translateX(-50%); /* Center the tooltip using transform */
            opacity: 0;
            transition: opacity 0.3s;
            font-size: 0.75rem; /* 12px */
            word-wrap: break-word; /* Prevent long IDs from breaking layout */
            pointer-events: none; /* Tooltip should not interfere with clicks */
        }
        .tooltip:hover .tooltiptext {
            visibility: visible;
            opacity: 1;
        }
        .tooltip .tooltiptext::after { /* Tooltip arrow */
            content: "";
            position: absolute;
            top: 100%;
            left: 50%;
            margin-left: -5px;
            border-width: 5px;
            border-style: solid;
            border-color: #555 transparent transparent transparent;
        }
    `;
    const styleSheet = document.createElement("style");
    styleSheet.id = styleId;
    styleSheet.type = "text/css";
    styleSheet.innerText = css;
    document.head.appendChild(styleSheet);
}


// --- Multiplayer Event Handlers (Callbacks for MPLib) ---

function handlePeerJoined(peerId, conn) {
    console.log(`MPLib Event: Peer joined - ${peerId.slice(-6)}`);
    showNotification(`Peer ${peerId.slice(-6)} connected.`, 'success', 2000);
    renderLobby();
}

function handlePeerLeft(peerId) {
    console.log(`MPLib Event: Peer left - ${peerId.slice(-6)}`);
    showNotification(`Peer ${peerId.slice(-6)} disconnected.`, 'warn', 2000);
    renderLobby();
}

function handleDataReceived(senderId, data) {
    console.log(`MPLib Event: Data received from ${senderId.slice(-6)}`, data);
    if (!data || !data.type) {
        console.warn("Received data without type from peer:", senderId.slice(-6));
        return;
    }

    switch (data.type) {
        case 'date_proposal':
            console.log(`Received date proposal from ${senderId}`);
            // Store proposal details before showing modal
            incomingProposal = {
                proposerId: senderId,
                proposerExplicitMode: data.payload?.proposerExplicitMode || false
            };
            showProposalModal();
            break;
        case 'date_accepted':
            console.log(`Date proposal accepted by ${senderId}`);
            showNotification(`Your date with ${senderId.slice(-4)} was accepted! Starting...`, "success");
            const accepterExplicitMode = data.payload?.accepterExplicitMode || false;
            isDateExplicit = isExplicitMode && accepterExplicitMode;
            console.log(`Date explicit mode set to: ${isDateExplicit}`);
            startNewDate(senderId, true); // We are Player 1 (initiator)
            break;
        case 'date_declined':
            console.log(`Date proposal declined by ${senderId}`);
            showNotification(`Your date with ${senderId.slice(-4)} was declined.`, "warn");
            const button = document.querySelector(`.propose-date-button[data-peer-id="${senderId}"]`);
            if (button) {
                button.disabled = false;
                button.textContent = 'Propose Date';
            }
            break;
        case 'turn_actions':
            // This is Player 1 receiving actions from Player 2
            console.log(`Received turn actions from ${senderId}`);
            if (isDateActive && amIPlayer1) {
                partnerActions = data.payload;
                isMyTurn = true;
                updateTurnStatusDisplay();
                // Now Player 1 can take their turn.
            }
            break;
        case 'new_turn_ui':
            // This is Player 2 receiving their new UI from Player 1
            console.log(`Received new turn UI from ${senderId}`);
            if (isDateActive && !amIPlayer1) {
                currentUiJson = data.payload;
                renderUI(currentUiJson);
                playTurnAlertSound();
                isMyTurn = true;
                updateTurnStatusDisplay();
            }
            break;
        default:
            console.warn(`Received unknown message type '${data.type}' from ${senderId.slice(-6)}`);
    }
}

function handleStatusUpdate(message) {
    console.log(`MPLib Status: ${message}`);
    // Optionally display less critical status updates somewhere
    // showNotification(message, 'info', 1500);
}

function handleError(type, error) {
    console.error(`MPLib Error (${type}):`, error);
    //showError(`Network Error (${type}): ${error?.message || error || 'Unknown error'}`);
}

function handleBecameHost() {
    console.log("This client BECAME THE HOST.");
    showNotification("You are now the host!", 'success');
    updatePeerListUI();
    // Host specific logic might go here
}

function handleConnectedToHost(hostId) {
    console.log(`Successfully connected to HOST: ${hostId}`);
    showNotification(`Connected to host ${hostId.slice(-6)}`, 'success');
    updatePeerListUI();
    // Client specific logic after connecting might go here
    // Maybe request state from host automatically?
    // console.log(`Requesting initial game state from host ${hostId.slice(-6)}...`);
    // MPLib.sendDirect(hostId, { type: 'request_game_state' });
}


// --- Event Listeners ---
    h1.addEventListener('click', () => {
        showAnalysisModal()
    })


// Modify the original click listener
submitButton.addEventListener('click', () => {
    if (isLoading) return;

    if (isDateActive) {
        // --- Two-Player Date Logic ---
        if (!isMyTurn) {
            showNotification("Not your turn!", "warn");
            return;
        }

        const myActionsString = collectInputState();

        if (amIPlayer1) {
            // Player 1's turn: They must have received actions from Player 2
            if (!partnerActions) {
                showNotification("Waiting for your partner's actions first!", "warn");
                return;
            }
            console.log("Player 1 is submitting combined turn.");

            const myParsedActions = JSON.parse(myActionsString);
            const partnerParsedActions = JSON.parse(partnerActions);

            const turnData = {
                isFirstTurn: false,
                playerA_actions: myParsedActions,
                playerB_actions: partnerParsedActions,
                playerA_notes: myParsedActions.notes,
                playerB_notes: partnerParsedActions.notes,
                isExplicit: isDateExplicit
            };

            fetchTurnData(turnData);
            isMyTurn = false;
            partnerActions = null; // Reset for the next turn
            updateTurnStatusDisplay();

        } else {
            // Player 2's turn: Send actions to Player 1
            console.log("Player 2 is sending actions to Player 1.");
            MPLib.sendDirect(currentPartnerId, { type: 'turn_actions', payload: myActionsString });
            isMyTurn = false;
            updateTurnStatusDisplay();
        }

    } else {
        // --- Original Single-Player Logic ---
        console.log("Submit button clicked (single-player mode).");
        initAudioContext();
        const playerActions = collectInputState();
        const parsedActions = JSON.parse(playerActions);
        // For single player, historyQueue is still managed by the global variable
        fetchTurnData({ playerA_actions: parsedActions, historyQueue: historyQueue, isExplicitMode: isExplicitMode, playerA_notes: parsedActions.notes });
    }
});
// --- MODIFICATION END: Long Press Logic ---


apiKeyInput.addEventListener('input', () => {
    const keyPresent = apiKeyInput.value.trim().length > 0;
    submitButton.disabled = isLoading || !(apiKeyLocked || keyPresent);
    resetGameButton.disabled = isLoading || (!apiKeyLocked && !keyPresent);
    if (apiKeySection.style.display !== 'none') {
        const currentInitialMessage = document.getElementById('initial-message');
        if (keyPresent) {
            hideError();
            if (currentInitialMessage && currentInitialMessage.style.display !== 'none') currentInitialMessage.textContent = 'API Key entered. Click "Submit Turn" to begin!';
        } else {
            if (currentInitialMessage) {
                currentInitialMessage.innerHTML = 'Enter API Key';
                currentInitialMessage.style.display = 'block';
            }
        }
    }
});

modeToggleButton.addEventListener('click', () => {
    if (isLoading) return;
    isExplicitMode = !isExplicitMode;
    console.log(`18+ Mode Toggled: ${isExplicitMode ? 'On' : 'Off'}`);
    updateModeButtonVisuals();
    autoSaveGameState();
});

resetGameButton.addEventListener('click', () => {
    if (isLoading || resetGameButton.disabled) return;
    if (confirm('Reset game? This will clear local progress. Are you sure?')) {
        console.log("Resetting game state...");
        historyQueue = [];
        currentUiJson = null;
        currentNotes = {};
        currentSubjectId = "";
        currentModelIndex = 0;
        apiKeyLocked = false;
        hiddenAnalysisContent = null; // Clear analysis content
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        console.log("Cleared localStorage.");
        uiContainer.innerHTML = '';
        hideError();
        if (apiKeySection) apiKeySection.style.display = 'block';
        let currentInitialMessage = document.getElementById('initial-message') || createInitialMessage();
        currentInitialMessage.style.display = 'block';
        currentInitialMessage.innerHTML = 'Enter secure API Key to begin'
        const keyPresent = apiKeyInput.value.trim().length > 0;
        setLoading(false);
        submitButton.disabled = !keyPresent;
        resetGameButton.disabled = !keyPresent;
        modeToggleButton.disabled = false;
        updateModeButtonVisuals();

        // // --- Multiplayer Reset ---
        // if (MPLib && typeof MPLib.disconnect === 'function') {
        //     console.log("Disconnecting from multiplayer network.");
        //     MPLib.disconnect();
        // } else if (MPLib && MPLib.peer && !MPLib.peer.destroyed) {
        //     try { MPLib.peer.destroy(); console.log("Destroyed PeerJS object."); } catch (e) { console.error("Error destroying PeerJS object:", e); }
        // }
        // remoteGameStates.clear(); // Clear stored remote states
        // localGameStateSnapshot = null; // Clear local snapshot
        // if (peerListContainer) peerListContainer.innerHTML = ''; // Clear peer list UI
        // console.log("Multiplayer state reset.");
        // Re-initialize multiplayer? Or require manual reconnect?
        // Let's assume reset means full stop for now. User would refresh/rejoin.
    }
});

// Add listener for the modal close button (if it exists)
if (analysisModalClose) {
    analysisModalClose.addEventListener('click', hideAnalysisModal);
}
// Optional: Close modal if clicking outside the content area
if (analysisModal) {
    analysisModal.addEventListener('click', (event) => {
        // Check if the click was directly on the modal background, not the content area
        if (event.target === analysisModal) {
            hideAnalysisModal();
        }
    });
}


// --- Initial Game Setup ---

/** Renders the lobby UI */
function renderLobby() {
    if (!lobbyContainer) return;

    // Ensure the correct view is shown
    lobbyContainer.style.display = 'block';
    gameWrapper.style.display = 'none';

    lobbyContainer.innerHTML = '<h2>Welcome to the Lobby</h2>';
    const grid = document.createElement('div');
    grid.className = 'lobby-grid';

    const peers = MPLib.getConnections ? Array.from(MPLib.getConnections().keys()) : [];

    if (peers.length === 0) {
        grid.innerHTML = '<p>No other users are currently online. Please wait for someone to connect.</p>';
    } else {
        peers.forEach(peerId => {
            const card = document.createElement('div');
            card.className = 'profile-card';

            const avatar = document.createElement('div');
            avatar.className = 'profile-avatar';
            const randomSeed = peerId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
            avatar.innerHTML = `<img src="https://image.pollinations.ai/prompt/cute%20cartoon%20animal%20avatar?seed=${randomSeed}&nologo=true&safe=false" alt="User Avatar">`;

            const name = document.createElement('div');
            name.className = 'profile-name';
            name.textContent = `User-${peerId.slice(-4)}`;

            const id = document.createElement('div');
            id.className = 'profile-id';
            id.textContent = `ID: ${peerId}`;

            const button = document.createElement('button');
            button.className = 'geems-button propose-date-button';
            button.textContent = 'Propose Date';
            button.dataset.peerId = peerId; // Store peerId for the handler
            button.onclick = (event) => {
                console.log(`Proposing date to ${peerId}`);
                const payload = {
                    proposerExplicitMode: isExplicitMode
                };
                MPLib.sendDirect(peerId, { type: 'date_proposal', payload: payload });
                event.target.disabled = true;
                event.target.textContent = 'Request Sent';
            };

            card.appendChild(avatar);
            card.appendChild(name);
            card.appendChild(id);
            card.appendChild(button);
            grid.appendChild(card);
        });
    }

    lobbyContainer.appendChild(grid);
}

/** Shows the date proposal modal and sets up its button handlers. */
function showProposalModal() {
    if (!proposalModal || !incomingProposal) return;

    proposerName.textContent = `User-${incomingProposal.proposerId.slice(-4)}`;

    // Use .onclick to easily overwrite previous listeners
    proposalAcceptButton.onclick = () => {
        if (!incomingProposal) return;
        console.log(`Accepting date from ${incomingProposal.proposerId}`);
        const payload = {
            accepterExplicitMode: isExplicitMode
        };
        MPLib.sendDirect(incomingProposal.proposerId, { type: 'date_accepted', payload: payload });
        proposalModal.style.display = 'none';

        // Determine if the date is explicit
        isDateExplicit = isExplicitMode && incomingProposal.proposerExplicitMode;
        console.log(`Date explicit mode set to: ${isDateExplicit}`);

        startNewDate(incomingProposal.proposerId, false); // We are Player 2 (receiver)
        incomingProposal = null; // Clear the stored proposal
    };

    proposalDeclineButton.onclick = () => {
        if (!incomingProposal) return;
        console.log(`Declining date from ${incomingProposal.proposerId}`);
        MPLib.sendDirect(incomingProposal.proposerId, { type: 'date_declined' });
        proposalModal.style.display = 'none';
        incomingProposal = null; // Clear the stored proposal
    };

    proposalModal.style.display = 'flex';
}

/** Transitions from lobby to game view and initializes date state */
function startNewDate(partnerId, iAmPlayer1) {
    console.log(`Starting new date with ${partnerId}. Am I Player 1? ${iAmPlayer1}`);

    isDateActive = true;
    currentPartnerId = partnerId;
    amIPlayer1 = iAmPlayer1;
    isMyTurn = iAmPlayer1; // Player 1 goes first
    partnerActions = null;

    // Hide lobby, show game
    lobbyContainer.style.display = 'none';
    gameWrapper.style.display = 'block';

    // This will be replaced by the actual first turn UI from the AI
    uiContainer.innerHTML = `<div class="text-center p-8"><h2>Date with ${partnerId.slice(-4)} has started!</h2></div>`;

    updateTurnStatusDisplay();

    // Player 1 is responsible for fetching the first turn
    if (amIPlayer1) {
        console.log("I am Player 1, fetching the first turn.");
        const turnData = {
            isFirstTurn: true,
            playerA_id: MPLib.getLocalPeerId(),
            playerB_id: currentPartnerId,
            isExplicit: isDateExplicit
        };
        fetchTurnData(turnData);
    }
}

/** Updates the UI to show whose turn it is and manages the interstitial screen */
function updateTurnStatusDisplay() {
    if (!isDateActive) return;

    if (isMyTurn) {
        // Player 1's turn is only truly enabled when they have their partner's actions.
        const canPlayer1Go = amIPlayer1 && partnerActions !== null;
        const canPlayer2Go = !amIPlayer1;

        if (canPlayer1Go || canPlayer2Go) {
            showNotification("It's your turn!", "success", 2000);
            interstitialMessage.style.display = 'none';
            uiContainer.classList.remove('hidden-by-interstitial');
            submitButton.disabled = false;
        } else {
            // This case handles Player 1 waiting for Player 2's actions
            showNotification(`Waiting for User-${currentPartnerId.slice(-4)} to play...`, "info", 5000);
            interstitialMessage.style.display = 'flex';
            uiContainer.classList.add('hidden-by-interstitial');
            submitButton.disabled = true;
        }
    } else {
        // This handles when it's the other player's turn
        showNotification(`Waiting for User-${currentPartnerId.slice(-4)} to play...`, "info", 5000);
        interstitialMessage.style.display = 'flex';
        uiContainer.classList.add('hidden-by-interstitial');
        submitButton.disabled = true;
    }
}


function initializeGame() {
    console.log("Initializing SparkSync...");

    // Initially, only the game wrapper (containing the API key section) is visible
    gameWrapper.style.display = 'block';
    lobbyContainer.style.display = 'none';

    enterLobbyButton.addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();
        if (!apiKey) {
            showError("An API key is required to enter the lobby.");
            return;
        }

        // Key is present, lock it in and proceed to lobby
        apiKeyLocked = true;
        hideError();
        apiKeySection.style.display = 'none'; // Hide the key input section
        lobbyContainer.style.display = 'block'; // Show the lobby

        // NOW initialize multiplayer
        if (typeof MPLib !== 'undefined' && typeof MPLib.initialize === 'function') {
            console.log("Initializing Multiplayer Library...");
            MPLib.initialize({
                targetHostId: DEFAULT_HOST_ID,
                debugLevel: 1,
                onStatusUpdate: handleStatusUpdate,
                onError: handleError,
                onPeerJoined: handlePeerJoined,
                onPeerLeft: handlePeerLeft,
                onDataReceived: handleDataReceived,
                onConnectedToHost: (hostId) => {
                    showNotification(`Connected to host ${hostId.slice(-6)}`, 'success');
                    renderLobby();
                },
                onBecameHost: () => {
                    showNotification("You are now the host!", 'success');
                    renderLobby();
                },
            });
        } else {
            console.warn("MPLib not found or initialize function missing.");
            lobbyContainer.innerHTML = '<p class="error-message">Error: Multiplayer library failed to load. Please refresh.</p>';
        }
        renderLobby(); // Initial render
    });
}

function createInitialMessage() {
    const msgDiv = document.createElement('div');
    msgDiv.id = 'initial-message';
    msgDiv.className = 'text-center text-gray-500 p-6 bg-white rounded-lg shadow';
    uiContainer.appendChild(msgDiv);
    return msgDiv;
}

// Ensure DOM is fully loaded before initializing
document.addEventListener('DOMContentLoaded', initializeGame);



