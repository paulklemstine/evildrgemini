// Import prompts from the separate prompt.js file
// Make sure 'prompt.js' is in the same directory as index.html or adjust the path.
import { geemsPrompts } from './prompts.js';

// --- Game State Variables ---
let historyQueue = [];
const MAX_HISTORY_SIZE = 20;
let currentUiJson = null;
let currentNotes = {};
let currentSubjectId = "";
let isMasturbationMode = false;
let isLoading = false;
let apiKeyLocked = false;

// --- Model Switching State ---
const AVAILABLE_MODELS = ["gemini-2.5-pro-exp-03-25",
    "gemini-2.0-pro-exp-02-05",
    "gemini-1.5-pro",
    "gemini-2.0-flash-exp",
    "gemini-exp-1206"];
let currentModelIndex = 0;

// --- Temporary storage ---
let pendingPlayerAnalysis = null;
let pendingGeminiAnalysis = null;
let pendingTweetData = null;

// --- Configuration ---
const MIN_CONTRAST_LIGHTNESS = 0.55;
const LOCAL_STORAGE_KEY = 'geemsGameStateToRestore';

// --- DOM Element References (Declare potentially null initially) ---
let uiContainer = null;
let loadingIndicator = null;
let submitButton = null;
let apiKeyInput = null;
let apiKeySection = null;
let errorDisplay = null;
let modeToggleButton = null;
let resetGameButton = null;
let clipboardMessage = null;
let headerBanner = null;
let footerBanner = null;
let footerIconImage = null;


// --- Web Audio API Context ---
let audioCtx = null;

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
function constructPrompt(playerActionsJson, historyQueue, isMasturbationMode) {
    const baseMainPrompt = geemsPrompts.main;
    const activeAddendum = isMasturbationMode ? `\n\n---\n${geemsPrompts.masturbationModeAddendum}\n---\n` : "";

    if (historyQueue.length === 0) {
        const s = `${geemsPrompts.firstrun}\n\n---\n${baseMainPrompt}${activeAddendum}\n---\n${geemsPrompts.exampleTurn}\n---\n\n--- Generate JSON UI for Turn 1 ---`;
        // console.log("First Turn Prompt:", s);
        return s;
    } else {
        const historyString = historyQueue.map(item => `UI:\n${item.ui}\nActions:\n${item.actions}`).join('\n---\n');
        const s = `${baseMainPrompt}${activeAddendum}\n\n--- Last Player Actions ---\n${playerActionsJson}\n\n--- Prior Game History (Last ${historyQueue.length} turns) ---\n${historyString}\n\n--- Generate Next Game Turn JSON UI ARRAY ---`;
        // console.log("Subsequent Turn Prompt:", s);
        return s;
    }
}

/** Saves essential game state to local storage. */
function autoSaveGameState() {
    if (!apiKeyLocked || !currentUiJson || !historyQueue || !apiKeyInput) {
        // console.log("Auto-save skipped: Conditions not met.");
        return;
    }
    const rawApiKey = apiKeyInput.value.trim();
    if (!rawApiKey) {
        console.error("Auto-save failed: API Key is missing.");
        return;
    }
    try {
        const stateToSave = {
            encodedApiKey: encodeApiKey(rawApiKey),
            currentUiJson: currentUiJson,
            historyQueue: historyQueue,
            isMasturbationMode: isMasturbationMode,
            currentModelIndex: currentModelIndex
        };
        localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stateToSave));
        // console.log("Game state auto-saved.");
    } catch (error) {
        console.error("Error during auto-save:", error);
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        showError("Error auto-saving game state.");
    }
}

/** Initializes the AudioContext lazily. */
function initAudioContext() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            console.log("AudioContext initialized.");
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(err => console.error("Error resuming audio context:", err));
            }
        } catch (e) {
            console.error("Web Audio API not supported.", e);
            showError("Audio alerts not supported.");
        }
    } else if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(err => console.error("Error resuming suspended audio context:", err));
    }
}

/** Plays the turn alert sound. */
function playTurnAlertSound() {
    initAudioContext(); // Ensure context is ready
    if (!audioCtx || audioCtx.state !== 'running') {
        // console.warn("Cannot play sound: AudioContext not running.");
        return;
    }
    try {
        const now = audioCtx.currentTime;
        const totalDuration = 1.0;

        // Foghorn
        const foghornOsc = audioCtx.createOscillator();
        const foghornGain = audioCtx.createGain();
        foghornOsc.type = 'sawtooth';
        foghornOsc.frequency.setValueAtTime(80, now);
        foghornGain.gain.setValueAtTime(0.3, now);
        foghornGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        foghornOsc.connect(foghornGain).connect(audioCtx.destination);
        foghornOsc.start(now);
        foghornOsc.stop(now + 0.5);

        // Beep
        const beepOsc = audioCtx.createOscillator();
        const beepGain = audioCtx.createGain();
        beepOsc.type = 'square';
        // First beep
        beepOsc.frequency.setValueAtTime(440, now + 0.6);
        beepGain.gain.setValueAtTime(0, now + 0.6);
        beepGain.gain.linearRampToValueAtTime(0.2, now + 0.65);
        beepGain.gain.setValueAtTime(0.2, now + 0.75);
        beepGain.gain.linearRampToValueAtTime(0, now + 0.8);
        // Second beep
        beepOsc.frequency.setValueAtTime(523, now + 0.85);
        beepGain.gain.setValueAtTime(0, now + 0.85);
        beepGain.gain.linearRampToValueAtTime(0.2, now + 0.9);
        beepGain.gain.setValueAtTime(0.2, now + totalDuration - 0.05);
        beepGain.gain.linearRampToValueAtTime(0.001, now + totalDuration);
        beepOsc.connect(beepGain).connect(audioCtx.destination);
        beepOsc.start(now + 0.6);
        beepOsc.stop(now + totalDuration);

        // console.log("Playing turn alert sound.");
    } catch (e) {
        console.error("Error playing sound:", e);
    }
}

/** Updates the history queue. */
function updateHistoryQueue(playerActionsJson) {
    if (currentUiJson) {
        const previousTurnData = {
            ui: JSON.stringify(currentUiJson),
            actions: playerActionsJson || "{}"
        };
        if (historyQueue.length >= MAX_HISTORY_SIZE) {
            historyQueue.shift();
        }
        historyQueue.push(previousTurnData);
        // console.log(`History Queue size: ${historyQueue.length}/${MAX_HISTORY_SIZE}`);
    }
}

/** Processes successful API response. */
function processSuccessfulResponse(responseJson, playerActionsJson) {
    // History is updated before fetchTurnData now
    currentUiJson = responseJson;

    if (!apiKeyLocked) {
        apiKeyLocked = true;
        if (apiKeySection) apiKeySection.style.display = 'none';
        if (resetGameButton) resetGameButton.disabled = false;
        console.log("API Key locked.");
    }

    renderUI(currentUiJson);
    playTurnAlertSound();
    autoSaveGameState();
}

/** Fetches next turn data from API with retry/switching logic. */
async function fetchTurnData(playerActionsJson) {
    initAudioContext(); // Ensure audio is ready on interaction

    if (!apiKeyInput || !apiKeyInput.value.trim()) {
        showError("Please enter your Google AI API Key.");
        setLoading(false);
        if (apiKeySection && apiKeySection.style.display === 'none') {
            apiKeySection.style.display = 'block';
        }
        return;
    }
    const apiKey = apiKeyInput.value.trim();

    setLoading(true);
    hideError();
    updateHistoryQueue(playerActionsJson); // Update history *before* the call

    const initialMsgEl = document.getElementById('initial-message');
    if (initialMsgEl) initialMsgEl.style.display = 'none';

    let success = false;
    let attempts = 0;
    const maxAttempts = AVAILABLE_MODELS.length * 2 + 1;
    let currentAttemptConsecutiveErrors = 0;

    while (!success && attempts < maxAttempts) {
        attempts++;
        const currentModel = AVAILABLE_MODELS[currentModelIndex];
        console.log(`Attempt ${attempts}/${maxAttempts}: Model ${currentModel}`);

        try {
            const fullPrompt = constructPrompt(playerActionsJson, historyQueue, isMasturbationMode);
            const jsonStringResponse = await callRealGeminiAPI(apiKey, fullPrompt, currentModel);
            const responseJson = JSON.parse(jsonStringResponse);
            console.log(`Success with ${currentModel}.`);
            processSuccessfulResponse(responseJson, playerActionsJson);
            success = true;
        } catch (error) {
            console.error(`Error with ${currentModel} (Attempt ${attempts}):`, error);
            currentAttemptConsecutiveErrors++;
            const isQuotaError = error.message.includes('429') || /quota|resource/i.test(error.message);
            const shouldSwitch = isQuotaError || currentAttemptConsecutiveErrors >= 2;

            if (shouldSwitch && AVAILABLE_MODELS.length > 1) {
                const oldModel = AVAILABLE_MODELS[currentModelIndex];
                currentModelIndex = (currentModelIndex + 1) % AVAILABLE_MODELS.length;
                const newModel = AVAILABLE_MODELS[currentModelIndex];
                console.warn(`Switching model from ${oldModel} to ${newModel}.`);
                showError(`Issue with ${oldModel}. Trying ${newModel}...`);
                currentAttemptConsecutiveErrors = 0;
            } else if (attempts < maxAttempts) {
                showError(`Temporary issue with ${currentModel}. Retrying...`);
                await new Promise(resolve => setTimeout(resolve, 750));
            }
        }
    } // End while

    if (!success) {
        console.error(`Failed after ${maxAttempts} attempts.`);
        showError(`Failed after ${maxAttempts} attempts. Check API key/network/quota.`);
    } else {
        hideError();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setLoading(false);
}

/** Calls the Google AI API. */
async function callRealGeminiAPI(apiKey, promptText, modelName) {
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const requestBody = {
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: { temperature: 1.0, response_mime_type: "application/json" },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorBody = `API Error (${response.status})`;
        try { errorBody += `: ${JSON.stringify((await response.json()).error)}`; }
        catch (e) { try { errorBody += `: ${await response.text()}`; } catch (e2) { /* ignore */ } }
        console.error("API Fetch Error Details:", errorBody);
        throw new Error(errorBody);
    }

    const responseData = await response.json();

    if (responseData.promptFeedback?.blockReason) {
        throw new Error(`API Request Blocked: ${responseData.promptFeedback.blockReason}`);
    }
    if (!responseData.candidates?.length) {
        throw new Error('No candidates generated or invalid API response.');
    }

    const candidate = responseData.candidates[0];

    if (candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS") {
        console.warn(`API Finish Reason: ${candidate.finishReason}`, candidate.safetyRatings);
        // Allow processing even if finished due to SAFETY, but log it
        if (candidate.finishReason === "SAFETY") {
            console.error("API Call Finished due to SAFETY:", candidate.safetyRatings);
        }
        if (!candidate.content?.parts?.length) {
            throw new Error(`API finish reason ${candidate.finishReason} with no content.`);
        }
    }

    if (candidate.content?.parts?.length) {
        let generatedText = candidate.content.parts[0].text;
        const jsonMatch = generatedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch?.[1]) generatedText = jsonMatch[1];
        const trimmedText = generatedText.trim();
        try {
            JSON.parse(trimmedText); // Validate JSON
            return trimmedText;
        } catch (e) {
            console.error("Invalid JSON structure received:", trimmedText.substring(0, 200), e);
            throw new Error(`Invalid JSON received from API.`);
        }
    } else {
        console.warn("API candidate missing content parts:", candidate);
        throw new Error('API candidate generated but missing content.');
    }
}


/** Renders UI elements from JSON array. */
function renderUI(uiJsonArray) {
    if (!uiContainer) {
        console.error("Cannot render UI: uiContainer is null.");
        return;
    }
    uiContainer.innerHTML = ''; // Clear previous UI
    pendingPlayerAnalysis = null;
    pendingGeminiAnalysis = null;
    pendingTweetData = null;

    if (!Array.isArray(uiJsonArray)) {
        console.error("Invalid UI data: Expected an array.", uiJsonArray);
        showError("Invalid UI data format from API.");
        return;
    }
    // console.log(`Rendering ${uiJsonArray.length} elements.`);

    // Pass 1: Find special elements
    uiJsonArray.forEach(element => {
        if (element.type === 'text' && element.name === 'player_facing_analysis') pendingPlayerAnalysis = element;
        else if (element.type === 'text' && element.name === 'gemini_facing_analysis') pendingGeminiAnalysis = element;
        else if (element.type === 'hidden' && element.name === 'tweet') pendingTweetData = element;
    });

    // Pass 2: Render non-special elements
    uiJsonArray.forEach((element, index) => {
        if (element !== pendingPlayerAnalysis && element !== pendingGeminiAnalysis && element !== pendingTweetData) {
            renderSingleElement(element, index);
        }
    });

    // Render combined analysis toggle
    if (pendingPlayerAnalysis && pendingGeminiAnalysis) {
        renderAnalysisToggle(pendingPlayerAnalysis, pendingGeminiAnalysis);
    } else {
        if (pendingPlayerAnalysis) renderSingleElement(pendingPlayerAnalysis, -1);
        if (pendingGeminiAnalysis) renderSingleElement(pendingGeminiAnalysis, -1);
    }

    // Render hidden tweet
    if (pendingTweetData) {
        renderTweetElement(pendingTweetData);
    }

    // Position analysis toggle after image
    const imageElement = uiContainer.querySelector('.geems-image-container');
    const analysisToggleContainer = uiContainer.querySelector('.analysis-toggle-container');
    if (imageElement && analysisToggleContainer) {
        imageElement.after(analysisToggleContainer); // Simpler insertion
    }

    // Position tweet after analysis toggle
    const tweetElement = document.getElementById('tweet-element-wrapper');
    if (analysisToggleContainer && tweetElement) {
        analysisToggleContainer.after(tweetElement); // Simpler insertion
    }
    // console.log("Finished rendering elements.");
}


/** Renders a single UI element. */
function renderSingleElement(element, index) {
    if (!uiContainer) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'geems-element';
    if (element.voice) wrapper.classList.add(`voice-${element.voice}`);

    let adjustedColor = null;
    if (element.color && isValidHexColor(element.color)) {
        adjustedColor = adjustColorForContrast(element.color);
        wrapper.style.borderLeftColor = adjustedColor;
        if (wrapper.classList.contains('analysis-toggle-container')) {
            wrapper.style.borderColor = adjustedColor; // Apply to all borders for toggle
        }
    } else {
        wrapper.style.borderLeftColor = 'transparent';
    }

    try {
        switch (element.type) {
            case 'image': renderImage(wrapper, element, adjustedColor); break;
            case 'text':
                // Handled separately if part of toggle
                if (element !== pendingPlayerAnalysis && element !== pendingGeminiAnalysis) {
                    renderText(wrapper, element, adjustedColor);
                } else return; // Skip rendering here
                break;
            case 'textfield': renderTextField(wrapper, element, adjustedColor); break;
            case 'checkbox': renderCheckbox(wrapper, element, adjustedColor); break;
            case 'slider': renderSlider(wrapper, element, adjustedColor); break;
            case 'radio': renderRadio(wrapper, element, adjustedColor); break;
            case 'hidden':
                if (element.name === 'notes') currentNotes = element.value || null;
                else if (element.name === 'subjectId') currentSubjectId = element.value || "";
                return; // Don't append hidden elements
            default:
                console.warn("Unknown element type:", element.type);
                wrapper.textContent = `Unknown: ${element.type}`;
        }
        uiContainer.appendChild(wrapper);
    } catch (renderError) {
        console.error(`Error rendering element ${index}:`, renderError, element);
        const errorWrapper = document.createElement('div');
        errorWrapper.className = 'geems-element error-message';
        errorWrapper.textContent = `Render Error: ${element.name || element.type}.`;
        uiContainer.appendChild(errorWrapper);
    }
}

// --- UI Element Rendering Functions ---

function renderImage(wrapper, element, adjustedColor) {
    wrapper.classList.add('geems-image-container');
    const img = document.createElement('img');
    img.className = 'geems-image';
    const imagePrompt = element.value || 'abstract image';
    const randomSeed = Math.floor(Math.random() * 65536);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(imagePrompt)}?nologo=true&safe=false&seed=${randomSeed}`;
    img.src = imageUrl;
    img.alt = element.label || `Image: ${imagePrompt.substring(0, 50)}...`;
    img.onerror = () => {
        console.warn(`Failed to load image: ${imageUrl}`);
        img.src = `https://placehold.co/600x400/e0e7ff/4f46e5?text=Image+Error`;
        img.alt = `Error loading: ${imagePrompt.substring(0, 50)}...`;
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
    const useLabel = element.label && !['narrative', 'divine_wisdom', 'player_facing_analysis', 'gemini_facing_analysis'].some(namePart => element.name?.includes(namePart));

    if (useLabel) {
        const label = document.createElement('label');
        label.className = 'geems-label';
        if (adjustedColor) label.style.color = adjustedColor;
        label.textContent = element.label;
        wrapper.appendChild(label);
    }
    const textElement = document.createElement('div');
    textElement.className = 'geems-text';
    textElement.innerHTML = textContent
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, '<br>')}</pre>`)
        .replace(/\n/g, '<br>');
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
    // if (adjustedColor) label.style.color = adjustedColor; // Label color inherited often better
    label.className = "ml-2 flex-grow cursor-pointer";

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
        // For browsers supporting ::thumb directly via JS variable
        input.style.setProperty('--slider-thumb-color', adjustedColor);
    }

    const valueDisplay = document.createElement('span');
    valueDisplay.className = `geems-slider-value-display font-medium w-12 text-right`;
    valueDisplay.textContent = input.value;
    if (adjustedColor) valueDisplay.style.color = adjustedColor;

    input.oninput = () => { valueDisplay.textContent = input.value; };

    sliderContainer.appendChild(input);
    sliderContainer.appendChild(valueDisplay);
    wrapper.appendChild(sliderContainer);
}

function renderRadio(wrapper, element, adjustedColor) {
    const label = document.createElement('label');
    label.className = 'geems-label';
    label.textContent = element.label || element.name;
    if (adjustedColor) label.style.color = adjustedColor;
    wrapper.appendChild(label);

    let options = [];
    let defaultValue = null;
    let optionsSource = element.options || element.value;

    try {
        if (typeof optionsSource === 'string') {
            try { optionsSource = JSON.parse(optionsSource); }
            catch (e) { optionsSource = [{ label: optionsSource, value: optionsSource }]; }
        }

        if (Array.isArray(optionsSource)) {
            options = optionsSource.map(opt => {
                let currentLabel = '', currentValue = '', isDefault = false;
                if (typeof opt === 'object' && opt !== null && opt.value !== undefined) {
                    currentValue = String(opt.value);
                    currentLabel = opt.label !== undefined ? String(opt.label) : currentValue;
                    if (currentLabel.startsWith('*')) { defaultValue = currentValue; currentLabel = currentLabel.substring(1); isDefault = true; }
                } else {
                    currentValue = String(opt);
                    currentLabel = currentValue;
                    if (currentLabel.startsWith('*')) { defaultValue = currentValue.substring(1); currentValue = defaultValue; currentLabel = defaultValue; isDefault = true; }
                }
                return { value: currentValue, label: currentLabel, isDefault: isDefault };
            }).filter(Boolean); // Filter out nulls/undefined

            // Fallback default check if '*' not used
            if (defaultValue === null && element.value && typeof element.value === 'string') {
                let isValueSimpleString = true;
                try { if (Array.isArray(JSON.parse(element.value))) isValueSimpleString = false; } catch (e) { /*ignore*/ }
                if (isValueSimpleString) {
                    const directValueMatch = options.find(opt => opt.value === element.value);
                    if (directValueMatch) defaultValue = directValueMatch.value;
                }
            }
        } else {
            console.warn("Unexpected radio options format:", element.name, optionsSource);
        }
    } catch (e) { console.error("Failed to process radio options:", element.name, e); }

    if (defaultValue === null && options.length > 0) defaultValue = options[0].value; // Default to first if none set

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
            optionLabel.className = "ml-2 flex-grow cursor-pointer";

            optionDiv.appendChild(input);
            optionDiv.appendChild(optionLabel);
            wrapper.appendChild(optionDiv);
        });
    } else {
        wrapper.innerHTML += `<p class="text-sm text-red-600">Error: No options for radio group '${element.name}'.</p>`;
    }
}

function renderAnalysisToggle(playerAnalysisElem, geminiAnalysisElem) {
    if (!uiContainer) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'geems-element analysis-toggle-container';
    if (geminiAnalysisElem.voice) wrapper.classList.add(`voice-${geminiAnalysisElem.voice}`);

    const rawColor = (geminiAnalysisElem.color && isValidHexColor(geminiAnalysisElem.color)) ? geminiAnalysisElem.color : '#10b981';
    const borderColor = adjustColorForContrast(rawColor);
    wrapper.style.borderColor = borderColor;

    const playerDiv = document.createElement('div');
    playerDiv.className = 'analysis-content player-analysis';
    playerDiv.style.display = 'block';
    renderAnalysisContent(playerDiv, playerAnalysisElem, borderColor);

    const geminiDiv = document.createElement('div');
    geminiDiv.className = 'analysis-content gemini-analysis';
    geminiDiv.style.display = 'none';
    renderAnalysisContent(geminiDiv, geminiAnalysisElem, borderColor);

    const icon = document.createElement('i');
    icon.className = 'lucide lucide-repeat analysis-toggle-icon';
    if (borderColor) wrapper.style.setProperty('--toggle-hover-color', borderColor);

    wrapper.appendChild(playerDiv);
    wrapper.appendChild(geminiDiv);
    wrapper.appendChild(icon);

    wrapper.addEventListener('click', (event) => {
        if (event.target.closest('pre')) return; // Allow selecting text in code blocks

        const isPlayerVisible = playerDiv.style.display !== 'none';
        playerDiv.style.display = isPlayerVisible ? 'none' : 'block';
        geminiDiv.style.display = isPlayerVisible ? 'block' : 'none';

        const tweetWrapper = document.getElementById('tweet-element-wrapper');
        if (tweetWrapper) tweetWrapper.style.display = geminiDiv.style.display;

        icon.style.transform = geminiDiv.style.display !== 'none' ? 'translateY(-50%) rotate(180deg)' : 'translateY(-50%) rotate(0deg)';
    });
    uiContainer.appendChild(wrapper);
}

function renderAnalysisContent(containerDiv, analysisElement, borderColor) {
    const textContent = analysisElement.text || analysisElement.value || '';
    if (analysisElement.label) {
        const analysisLabel = document.createElement('div');
        analysisLabel.className = 'geems-label font-semibold mb-2';
        if (borderColor) {
            analysisLabel.style.color = borderColor;
            analysisLabel.style.borderBottomColor = borderColor;
        }
        analysisLabel.textContent = analysisElement.label;
        containerDiv.appendChild(analysisLabel);
    }
    const textElement = document.createElement('div');
    textElement.className = 'geems-text';
    // Simplified markdown - adjust if full markdown library is needed
    textElement.innerHTML = textContent
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/```([\s\S]*?)```/g, (match, p1) => `<pre>${p1.trim().replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, '<br>')}</pre>`)
        .replace(/\n/g, '<br>');
    containerDiv.appendChild(textElement);
}

function renderTweetElement(tweetData) {
    if (!uiContainer) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'tweet-element-wrapper';
    wrapper.className = 'geems-element';
    wrapper.style.display = 'none'; // Start hidden

    const label = document.createElement('div');
    label.className = 'geems-label';
    label.textContent = 'Gemini\'s Internal Tweet Stream:';
    wrapper.appendChild(label);

    const tweetContent = document.createElement('div');
    tweetContent.className = 'geems-text';
    tweetContent.textContent = tweetData.value || 'No tweet content.';
    wrapper.appendChild(tweetContent);

    // Insert after analysis toggle (best effort)
    const analysisToggle = uiContainer.querySelector('.analysis-toggle-container');
    if (analysisToggle) {
        analysisToggle.after(wrapper);
    } else {
        // Fallback: append after last element if toggle not found yet
        uiContainer.appendChild(wrapper);
    }
}


// --- Utility Functions ---

/** Collects state of interactive UI elements. */
function collectInputState() {
    const inputs = {};
    if (!uiContainer) return JSON.stringify(inputs);

    uiContainer.querySelectorAll('[data-element-type]').forEach(el => {
        const name = el.name;
        if (!name) return;
        const type = el.dataset.elementType;
        switch (type) {
            case 'textfield': inputs[name] = el.value; break;
            case 'checkbox': inputs[name] = el.checked; break;
            case 'slider': inputs[name] = parseFloat(el.value); break;
            case 'radio': if (el.checked) inputs[name] = el.value; break;
        }
    });
    inputs['turn'] = historyQueue.length + 1; // Turn number based on history *before* this turn
    // console.log("Collected Inputs:", inputs);
    return JSON.stringify(inputs);
}

/** Sets loading state for UI. */
function setLoading(loading) {
    isLoading = loading;
    if (loadingIndicator) loadingIndicator.style.display = loading ? 'flex' : 'none';

    const keyPresent = apiKeyInput?.value.trim().length > 0;
    if(submitButton) submitButton.disabled = loading || !(apiKeyLocked || keyPresent);
    if(modeToggleButton) modeToggleButton.disabled = loading;
    if(resetGameButton) resetGameButton.disabled = loading || !apiKeyLocked;

    if(uiContainer) {
        uiContainer.querySelectorAll('input, textarea, button, .analysis-toggle-container').forEach(el => {
            if (!['submit-turn', 'modeToggleButton', 'resetGameButton'].includes(el.id)) {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON') {
                    el.disabled = loading;
                }
                if (el.classList.contains('geems-radio-option') || el.classList.contains('geems-checkbox-option') || el.classList.contains('geems-slider') || el.classList.contains('analysis-toggle-container')) {
                    el.style.opacity = loading ? 0.5 : 1.0;
                    el.style.pointerEvents = loading ? 'none' : 'auto';
                }
            }
        });
    }
}

/** Displays an error message. */
function showError(message) {
    if (errorDisplay) {
        errorDisplay.textContent = message;
        errorDisplay.style.display = 'block';
    } else {
        console.error("Error Display Element not found, message:", message);
    }
}

/** Hides the error message. */
function hideError() {
    if (errorDisplay) {
        errorDisplay.textContent = '';
        errorDisplay.style.display = 'none';
    }
}

/** Checks if a string is a valid hex color. */
function isValidHexColor(hex) {
    return typeof hex === 'string' && /^#[0-9A-F]{6}$/i.test(hex);
}

/** Adjusts hex color for contrast. */
function adjustColorForContrast(hex) {
    if (!isValidHexColor(hex)) return hex;
    try {
        let r = parseInt(hex.substring(1, 3), 16), g = parseInt(hex.substring(3, 5), 16), b = parseInt(hex.substring(5, 7), 16);
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;

        if (max === min) { h = s = 0; }
        else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }

        if (l > MIN_CONTRAST_LIGHTNESS) {
            l = MIN_CONTRAST_LIGHTNESS * 0.9; // Reduce lightness
            let r1, g1, b1;
            if (s === 0) { r1 = g1 = b1 = l; }
            else {
                const hue2rgb = (p, q, t) => {
                    if (t < 0) t += 1; if (t > 1) t -= 1;
                    if (t < 1 / 6) return p + (q - p) * 6 * t;
                    if (t < 1 / 2) return q;
                    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                    return p;
                };
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                r1 = hue2rgb(p, q, h + 1 / 3); g1 = hue2rgb(p, q, h); b1 = hue2rgb(p, q, h - 1 / 3);
            }
            const toHex = x => { const hexVal = Math.round(x * 255).toString(16); return hexVal.length === 1 ? '0' + hexVal : hexVal; };
            return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
        }
    } catch (e) { console.error("Color adjustment error:", e); }
    return hex; // Return original on error or if no adjustment needed
}

/** Shows temporary clipboard message. */
function showClipboardMessage(message, isError = false) {
    if (clipboardMessage) {
        clipboardMessage.textContent = message;
        clipboardMessage.style.color = isError ? '#dc2626' : '#16a34a';
        setTimeout(() => { if(clipboardMessage) clipboardMessage.textContent = ''; }, 3000);
    }
}

/** Updates mode toggle button visuals. */
function updateModeButtonVisuals() {
    if (modeToggleButton) {
        if (isMasturbationMode) {
            modeToggleButton.textContent = 'Mode: Explicit';
            modeToggleButton.classList.remove('standard-mode');
        } else {
            modeToggleButton.textContent = 'Mode: Standard';
            modeToggleButton.classList.add('standard-mode');
        }
    }
}

/** Sets dynamic header/footer images. */
function setDynamicImages() {
    const headerSeed = Math.floor(Math.random() * 65536);
    const footerSeed = Math.floor(Math.random() * 65536);
    const iconSeed = Math.floor(Math.random() * 65536);
    const headerPrompt = "wide cinematic vivid colorful abstract emotional landscape brainwaves";
    const footerPrompt = "wide abstract colorful digital roots network connections";
    const iconPrompt = "pixel art floppy disk";

    if (headerBanner) {
        headerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(headerPrompt)}?width=1200&height=200&seed=${headerSeed}&nologo=true&safe=false`;
        headerBanner.alt = headerPrompt;
    }
    if (footerBanner) {
        footerBanner.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(footerPrompt)}?width=1200&height=100&seed=${footerSeed}&nologo=true&safe=false`;
        footerBanner.alt = footerPrompt;
    }
    if (footerIconImage) {
        footerIconImage.src = `https://image.pollinations.ai/prompt/${encodeURIComponent(iconPrompt)}?width=60&height=60&seed=${iconSeed}&nologo=true&safe=false`;
        footerIconImage.alt = iconPrompt;
    }
}


// --- Event Listener Setup Function ---
function setupEventListeners() {
    if (submitButton) {
        submitButton.addEventListener('click', () => {
            // console.log("Submit button clicked.");
            initAudioContext();
            const playerActions = collectInputState();
            if (isLoading) return;
            fetchTurnData(playerActions);
        });
    } else { console.error("Submit button not found for listener setup."); }

    if (apiKeyInput) {
        apiKeyInput.addEventListener('input', () => {
            const keyPresent = apiKeyInput.value.trim().length > 0;
            if(submitButton) submitButton.disabled = isLoading || !(apiKeyLocked || keyPresent);
            if(resetGameButton) resetGameButton.disabled = isLoading || !(apiKeyLocked || keyPresent);

            if (apiKeySection && apiKeySection.style.display !== 'none') {
                const currentInitialMessage = document.getElementById('initial-message');
                if (keyPresent) {
                    hideError();
                    if (currentInitialMessage && currentInitialMessage.style.display !== 'none') {
                        currentInitialMessage.textContent = 'API Key entered. Click "Submit Turn" to begin!';
                    }
                } else {
                    if (currentInitialMessage) {
                        currentInitialMessage.innerHTML = 'Enter API Key...'; // Simplified
                        currentInitialMessage.style.display = 'block';
                    }
                }
            }
        });
    } else { console.error("API Key input not found for listener setup."); }

    if (modeToggleButton) {
        modeToggleButton.addEventListener('click', () => {
            if (isLoading) return;
            isMasturbationMode = !isMasturbationMode;
            console.log(`Mode Toggled: ${isMasturbationMode ? 'Explicit' : 'Standard'}`);
            updateModeButtonVisuals();
            autoSaveGameState(); // Save state on mode change
        });
    } else { console.error("Mode toggle button not found for listener setup."); }

    if (resetGameButton) {
        resetGameButton.addEventListener('click', () => {
            if (isLoading || !apiKeyLocked) return;
            if (confirm('Reset game? All progress lost.')) {
                console.log("Resetting game...");
                historyQueue = []; currentUiJson = null; currentNotes = {};
                currentSubjectId = ""; currentModelIndex = 0;
                localStorage.removeItem(LOCAL_STORAGE_KEY);
                if (uiContainer) uiContainer.innerHTML = '';
                hideError();

                let initialMsg = document.getElementById('initial-message');
                if (!initialMsg && uiContainer) { // Recreate if needed
                    initialMsg = document.createElement('div');
                    initialMsg.id = 'initial-message';
                    initialMsg.className = 'text-center text-gray-500 p-6 bg-white rounded-lg shadow';
                    uiContainer.appendChild(initialMsg);
                }
                if(initialMsg) {
                    initialMsg.style.display = 'block';
                    initialMsg.innerHTML = 'Resetting... Loading first turn.';
                }

                if (submitButton) submitButton.disabled = false; // Should be enabled after reset if key valid
                if (resetGameButton) resetGameButton.disabled = false; // Keep enabled
                updateModeButtonVisuals(); // Reset button visual
                fetchTurnData("{}"); // Fetch turn 1
            }
        });
    } else { console.error("Reset button not found for listener setup."); }
}


// --- Initial Game Setup Function ---
function initializeGame() {
    console.log("Initializing GEEMS...");

    // Assign DOM element references safely after DOM load
    uiContainer = document.getElementById('ui-elements');
    loadingIndicator = document.getElementById('loading');
    submitButton = document.getElementById('submit-turn');
    apiKeyInput = document.getElementById('apiKeyInput');
    apiKeySection = document.getElementById('apiKeySection');
    errorDisplay = document.getElementById('error-display');
    modeToggleButton = document.getElementById('modeToggleButton');
    resetGameButton = document.getElementById('resetGameButton');
    clipboardMessage = document.getElementById('clipboardMessage');
    headerBanner = document.getElementById('headerBanner');
    footerBanner = document.getElementById('footerBanner');
    footerIconImage = document.getElementById('footerIconImage');

    // Ensure essential elements are present
    if (!uiContainer || !apiKeyInput || !submitButton || !apiKeySection) {
        console.error("Essential UI elements missing! Cannot initialize game properly.");
        document.body.innerHTML = '<p style="color: red; font-size: 1.2em; padding: 20px;">Error: Critical UI elements not found in HTML. Game cannot start.</p>';
        return;
    }


    let autoStarted = false;
    const storedStateString = localStorage.getItem(LOCAL_STORAGE_KEY);

    // 1. Try loading from localStorage
    if (storedStateString) {
        console.log("Attempting restore from localStorage...");
        try {
            const savedState = JSON.parse(storedStateString);
            const decodedApiKey = decodeApiKey(savedState.encodedApiKey);
            if (!decodedApiKey) throw new Error("Failed to decode API key.");

            apiKeyInput.value = decodedApiKey;
            historyQueue = savedState.historyQueue || [];
            currentUiJson = savedState.currentUiJson || null;
            isMasturbationMode = savedState.isMasturbationMode || false;
            currentModelIndex = savedState.currentModelIndex || 0;
            apiKeyLocked = true;
            autoStarted = true;

            console.log("State restored:", { h: historyQueue.length, m: isMasturbationMode, i: currentModelIndex });
            setDynamicImages();

            if (currentUiJson) {
                renderUI(currentUiJson);
            } else {
                localStorage.removeItem(LOCAL_STORAGE_KEY);
                throw new Error("Restored state missing UI data.");
            }

            updateModeButtonVisuals();
            apiKeySection.style.display = 'none';
            const initialMsg = document.getElementById('initial-message');
            if (initialMsg) initialMsg.style.display = 'none';
            hideError();
            setLoading(false);
            submitButton.disabled = false;
            resetGameButton.disabled = false;
            modeToggleButton.disabled = false;

        } catch (error) {
            console.error("Error restoring state:", error);
            showError(`Restore failed: ${error.message}. Start manually.`);
            localStorage.removeItem(LOCAL_STORAGE_KEY);
            // Reset state for clean manual start
            historyQueue = []; currentUiJson = null; currentModelIndex = 0;
            apiKeyLocked = false; autoStarted = false; apiKeyInput.value = '';
            uiContainer.innerHTML = ''; // Clear potentially broken UI
            const initialMsg = document.getElementById('initial-message');
            if (initialMsg) { initialMsg.style.display = 'block'; initialMsg.innerHTML = 'Restore Error. Enter API Key...'; }
            apiKeySection.style.display = 'block';
            submitButton.disabled = true; resetGameButton.disabled = true;
            setDynamicImages();
        }
    }

    // 2. Try loading from URL param (if not loaded from storage)
    if (!autoStarted) {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            const keyFromUrlParam = urlParams.get('apiKey');
            if (keyFromUrlParam) {
                console.log("API Key found in URL. Auto-starting...");
                apiKeyInput.value = keyFromUrlParam;
                apiKeyLocked = false; // Not locked until first fetch works
                currentModelIndex = 0; historyQueue = []; currentUiJson = null;

                apiKeySection.style.display = 'none';
                const initialMsg = document.getElementById('initial-message');
                if (initialMsg) initialMsg.style.display = 'none';
                submitButton.disabled = false; // Enable submit
                updateModeButtonVisuals();
                modeToggleButton.disabled = false;
                resetGameButton.disabled = true; // Until game starts

                // Clean URL
                const currentUrl = new URL(window.location.href);
                currentUrl.searchParams.delete('apiKey');
                window.history.replaceState(null, '', currentUrl.toString());

                setDynamicImages();
                fetchTurnData("{}"); // Fetch first turn
                autoStarted = true;
            }
        } catch (e) {
            console.error("Error processing URL params:", e);
            showError("URL parameter error. Start manually.");
            autoStarted = false; // Ensure manual start proceeds
        }
    }

    // 3. Manual Start Setup (if not auto-started)
    if (!autoStarted) {
        console.log("Manual start: Enter API Key or use save code.");
        historyQueue = []; currentUiJson = null; currentModelIndex = 0; apiKeyLocked = false;
        uiContainer.innerHTML = ''; // Clear UI

        let initialMsg = document.getElementById('initial-message');
        if (!initialMsg && uiContainer) { // Recreate if needed
            initialMsg = document.createElement('div');
            initialMsg.id = 'initial-message';
            initialMsg.className = 'text-center text-gray-500 p-6 bg-white rounded-lg shadow';
            uiContainer.appendChild(initialMsg);
        }
        if (initialMsg) {
            initialMsg.style.display = 'block';
            initialMsg.innerHTML = 'Enter API Key above or provide in URL parameter (?apiKey=...) to start.<br>Or, paste previously saved game code into console.';
        }

        apiKeySection.style.display = 'block';
        apiKeyInput.value = '';
        setLoading(false);
        hideError();
        submitButton.disabled = true; // Until key entered
        resetGameButton.disabled = true; // Until game starts
        modeToggleButton.disabled = false; // Can toggle mode before start
        updateModeButtonVisuals();
        setDynamicImages();
    }

    // Setup listeners regardless of start mode, now that elements are assigned
    setupEventListeners();
    console.log("GEEMS Initialization complete.");
}

// --- Initialize ---
// Ensure the DOM is ready before initializing and setting up listeners
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeGame);
} else {
    // DOMContentLoaded has already fired
    initializeGame();
}