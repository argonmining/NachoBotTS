import { Message, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, DMChannel, MessageComponentInteraction, ChannelType, TextBasedChannel } from 'discord.js';
import { generateNewWallet } from '../utils/generateNewWallet';
import { importWalletFromPrivateKey } from '../utils/importWallet';
import { sendKaspa } from '../utils/sendKaspa';
import { getBalance } from '../utils/getBalance';
import { userSettings, Network } from '../utils/userSettings';
import { getRpcClient } from '../utils/rpcConnection';
import axios, { AxiosResponse } from 'axios';
import { EmbedBuilder } from '@discordjs/builders';
import lodash from 'lodash';
import { createButton } from '../utils/utils';
import { Logger } from '../utils/logger';
import { handleError, AppError } from '../utils/errorHandler';
import { checkRateLimit, getRateLimitRemainingTime } from '../utils/rateLimit';
import { validateAddress, validateAmount, sanitizeInput, validatePrivateKey, validateNetwork } from '../utils/inputValidation';
import { retryableRequest, handleNetworkError } from '../utils/networkUtils';

const { debounce } = lodash;

enum WalletState {
  IDLE,
  NETWORK_SELECTION,
  WALLET_OPTIONS,
  WALLET_ACTIONS,
  SENDING_KASPA,
  CHECKING_BALANCE,
  VIEWING_HISTORY,
  IMPORTING_WALLET
}

const userWalletStates = new Map<string, WalletState>();

export const handleWalletCommand = async (message: Message) => {
    const userId = message.author.id;
    Logger.info(`Wallet command triggered by user: ${userId} in channel type: ${message.channel.type}`);

    let channel: DMChannel | TextBasedChannel;
    if (message.channel.type === ChannelType.DM) {
        channel = message.channel;
    } else {
        channel = await message.author.createDM();
        await message.reply("I've sent you a DM to start your wallet session!");
    }

    const currentState = userWalletStates.get(userId) || WalletState.IDLE;

    // Ignore messages if the user is in these states
    if ([WalletState.SENDING_KASPA, WalletState.IMPORTING_WALLET].includes(currentState)) {
        Logger.info(`Ignoring message for user ${userId} in state ${currentState}`);
        return;
    }

    try {
        const userSession = userSettings.get(userId);
        switch (currentState) {
            case WalletState.IDLE:
                await channel.send("Welcome to your private Kat Wallet Session. Let's start by choosing which Network you'll be using.");
                await promptNetworkSelection(channel, userId);
                break;
            case WalletState.NETWORK_SELECTION:
                await promptNetworkSelection(channel, userId);
                break;
            case WalletState.WALLET_OPTIONS:
                if (userSession && userSession.network) {
                    await promptWalletOptions(channel, userId, userSession.network);
                } else {
                    await promptNetworkSelection(channel, userId);
                }
                break;
            case WalletState.WALLET_ACTIONS:
                await promptWalletActions(channel, userId);
                break;
            default:
                Logger.warn(`Unexpected state for user ${userId}: ${currentState}`);
                userWalletStates.set(userId, WalletState.IDLE);
                await promptNetworkSelection(channel, userId);
        }
    } catch (error) {
        await handleError(error, channel, 'handleWalletCommand');
    }
};

const promptNetworkSelection = async (channel: DMChannel | TextBasedChannel, userId: string) => {
    Logger.info(`Starting network selection for user: ${userId}`);

    if (!checkRateLimit(userId, 'networkSelection')) {
        const remainingTime = getRateLimitRemainingTime(userId, 'networkSelection');
        throw new AppError(
            'Rate limit exceeded',
            `You're selecting networks too frequently. Please try again in ${Math.ceil(remainingTime / 1000)} seconds.`,
            'RATE_LIMIT_EXCEEDED'
        );
    }

    try {
        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Network Selection')
            .setDescription('Please select the network you want to use:');

        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                createButton('Mainnet', 'Mainnet', ButtonStyle.Primary),
                createButton('Testnet-10', 'Testnet-10', ButtonStyle.Secondary),
                createButton('Testnet-11', 'Testnet-11', ButtonStyle.Secondary)
            );

        const message = await channel.send({ embeds: [embed], components: [row] });

        const filter = (i: MessageComponentInteraction) => 
            ['Mainnet', 'Testnet-10', 'Testnet-11'].includes(i.customId) && i.user.id === userId;

        const interaction = await message.awaitMessageComponent({ filter, time: 300000 });
        await interaction.deferUpdate();

        const selectedNetwork = interaction.customId as Network;
        if (!validateNetwork(selectedNetwork)) {
            throw new AppError('Invalid network', 'Please select a valid network.', 'INVALID_NETWORK');
        }

        userSettings.set(userId, { network: selectedNetwork, lastActivity: Date.now() });

        Logger.info(`User ${userId} selected network: ${selectedNetwork}`);
        
        // Delete the network selection message
        await message.delete().catch(error => Logger.error(`Failed to delete network selection message: ${error}`));
        
        await channel.send(`You've selected ${selectedNetwork}. Let's set up your wallet.`);
        
        // Set the state to WALLET_OPTIONS after network selection
        userWalletStates.set(userId, WalletState.WALLET_OPTIONS);
        
        // Prompt for wallet options
        await promptWalletOptions(channel, userId, selectedNetwork);
    } catch (error) {
        await handleError(new AppError(
            `Error in network selection for user: ${userId}`,
            'Network selection timed out. Please use the !wallet command again to restart.',
            'NETWORK_SELECTION_TIMEOUT'
        ), channel, 'promptNetworkSelection');
        userWalletStates.delete(userId);
    }
};

const promptWalletOptions = async (channel: DMChannel | TextBasedChannel, userId: string, network: Network) => {
    Logger.info(`Prompting wallet options for user: ${userId}`);
    try {
        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Wallet Options')
            .setDescription('Please choose an option:');

        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                createButton('create', 'Create New Wallet', ButtonStyle.Primary),
                createButton('import', 'Import Existing Wallet', ButtonStyle.Secondary)
            );

        const message = await channel.send({ embeds: [embed], components: [row] });

        const filter = (i: MessageComponentInteraction) => 
            ['create', 'import'].includes(i.customId) && i.user.id === userId;

        const interaction = await message.awaitMessageComponent({ filter, time: 300000 });
        await interaction.deferUpdate();

        // Delete the wallet options message
        await message.delete().catch(error => Logger.error(`Failed to delete wallet options message: ${error}`));

        if (interaction.customId === 'create') {
            await createNewWallet(channel, userId, network);
        } else {
            await importExistingWallet(channel, userId, network);
        }
    } catch (error) {
        await handleError(error, channel, 'promptWalletOptions');
        userWalletStates.delete(userId);
    }
};

const createNewWallet = async (channel: DMChannel | TextBasedChannel, userId: string, network: Network) => {
    Logger.info(`Creating new wallet for user: ${userId}`);

    try {
        // Perform wallet creation without sending any messages
        const walletInfo = await generateNewWallet(userId, network);

        // Only after successful creation, send confirmation messages
        await channel.send('Your new wallet has been created. Please store this information securely:');
        await channel.send(`Address: ${walletInfo.address}`);
        await channel.send(`Private Key: ${walletInfo.privateKey}`);
        await channel.send(`Mnemonic: ${walletInfo.mnemonic}`);
        await channel.send('⚠️ WARNING: Never share your private key or mnemonic with anyone!');

        // Set the state to WALLET_ACTIONS
        userWalletStates.set(userId, WalletState.WALLET_ACTIONS);

        // Prompt for wallet actions
        await promptWalletActions(channel, userId);
    } catch (error) {
        await handleError(new AppError(
            `Error creating wallet for user: ${userId}`,
            'An error occurred while creating your wallet. Please try again.',
            'WALLET_CREATION_ERROR'
        ), channel, 'createNewWallet');
        // If there's an error, set the state back to WALLET_OPTIONS
        userWalletStates.set(userId, WalletState.WALLET_OPTIONS);
        await promptWalletOptions(channel, userId, network);
    }
};

const importExistingWallet = async (channel: DMChannel | TextBasedChannel, userId: string, network: Network) => {
    Logger.info(`Importing wallet for user: ${userId}`);
    userWalletStates.set(userId, WalletState.IMPORTING_WALLET);

    try {
        await channel.send('Please enter your private key:');

        const privateKeyFilter = (m: Message) => m.author.id === userId && validatePrivateKey(m.content);
        const privateKeyResponse = await channel.awaitMessages({
            filter: privateKeyFilter,
            max: 1,
            time: 60000,
            errors: ['time']
        });

        const privateKey = sanitizeInput(privateKeyResponse.first()?.content || '');

        // Perform wallet import
        const walletInfo = await importWalletFromPrivateKey(privateKey, userId, network);

        // Send confirmation message
        await channel.send(`Your wallet has been imported successfully. Address: ${walletInfo.address}`);

        // Set the state to WALLET_ACTIONS after successful import
        userWalletStates.set(userId, WalletState.WALLET_ACTIONS);
        Logger.info(`State set to WALLET_ACTIONS for user: ${userId}`);

        // Prompt for wallet actions
        await promptWalletActions(channel, userId);
    } catch (error) {
        await handleError(error, channel, 'importExistingWallet');
        // If there's an error, set the state back to WALLET_OPTIONS
        userWalletStates.set(userId, WalletState.WALLET_OPTIONS);
        await promptWalletOptions(channel, userId, network);
    }
};

const promptWalletActions = async (channel: DMChannel | TextBasedChannel, userId: string) => {
    Logger.info(`Prompting wallet actions for user: ${userId}`);
    try {
        if (!checkRateLimit(userId, 'walletActions')) {
            const remainingTime = getRateLimitRemainingTime(userId, 'walletActions');
            throw new AppError(
                'Rate limit exceeded',
                `You're performing wallet actions too frequently. Please try again in ${Math.ceil(remainingTime / 1000)} seconds.`,
                'RATE_LIMIT_EXCEEDED'
            );
        }

        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Wallet Actions')
            .setDescription('What would you like to do?');

        const row1 = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                createButton('send', 'Send Kaspa', ButtonStyle.Primary),
                createButton('balance', 'Check Balance', ButtonStyle.Secondary),
                createButton('history', 'Transaction History', ButtonStyle.Secondary)
            );

        const row2 = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                createButton('help', 'Help', ButtonStyle.Secondary),
                createButton('clear', 'Clear Chat', ButtonStyle.Danger),
                createButton('back', 'Back', ButtonStyle.Secondary)
            );

        const message = await channel.send({ embeds: [embed], components: [row1, row2] });

        const filter = (i: MessageComponentInteraction) => 
            ['send', 'balance', 'history', 'help', 'clear', 'back'].includes(i.customId) && i.user.id === userId;

        const interaction = await message.awaitMessageComponent({ filter, time: 300000 });
        await interaction.deferUpdate();

        switch (interaction.customId) {
            case 'send':
                await sendKaspaPrompt(channel, userId);
                break;
            case 'balance':
                await checkBalance(channel, userId);
                break;
            case 'history':
                await showTransactionHistory(channel, userId);
                break;
            case 'help':
                await showHelpMessage(channel, userId);
                break;
            case 'clear':
                await clearChatHistory(channel, userId);
                break;
            case 'back':
                userWalletStates.set(userId, WalletState.NETWORK_SELECTION);
                await promptNetworkSelection(channel, userId);
                return;
        }

        // Always prompt for wallet actions again after an action is completed
        await promptWalletActions(channel, userId);
    } catch (error) {
        await handleError(error, channel, 'promptWalletActions');
        userWalletStates.set(userId, WalletState.WALLET_ACTIONS);
        await promptWalletActions(channel, userId);
    }
};

const sendKaspaPrompt = async (channel: DMChannel | TextBasedChannel, userId: string) => {
    Logger.info(`Starting send Kaspa prompt for user: ${userId}`);
    userWalletStates.set(userId, WalletState.SENDING_KASPA);

    try {
        // Retrieve user's network
        const userSession = userSettings.get(userId);
        if (!userSession || !userSession.network) {
            throw new AppError('Invalid Session', 'Your wallet session is invalid. Please start over with the !wallet command.', 'INVALID_SESSION');
        }
        const network = userSession.network;

        // Ask for recipient address
        await channel.send('Please enter the recipient\'s Kaspa address:');
        const addressResponse = await channel.awaitMessages({
            filter: (m: Message) => m.author.id === userId,
            max: 1,
            time: 60000,
            errors: ['time']
        });
        const recipientAddress = sanitizeInput(addressResponse.first()?.content || '');

        if (!validateAddress(recipientAddress)) {
            throw new AppError('Invalid Address', 'The recipient address you entered is invalid.', 'INVALID_ADDRESS');
        }

        // Ask for amount
        await channel.send('Please enter the amount of KAS to send:');
        const amountResponse = await channel.awaitMessages({
            filter: (m: Message) => m.author.id === userId,
            max: 1,
            time: 60000,
            errors: ['time']
        });
        const amount = sanitizeInput(amountResponse.first()?.content || '');

        if (!validateAmount(amount)) {
            throw new AppError('Invalid Amount', 'The amount you entered is invalid.', 'INVALID_AMOUNT');
        }

        // Confirm transaction
        const confirmEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('Confirm Transaction')
            .setDescription('Please confirm the transaction details:')
            .addFields(
                { name: 'Amount', value: `${amount} KAS` },
                { name: 'Recipient Address', value: recipientAddress }
            );

        const confirmRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                createButton('confirm_send', 'Confirm', ButtonStyle.Success),
                createButton('cancel_send', 'Cancel', ButtonStyle.Danger)
            );

        const confirmMessage = await channel.send({ embeds: [confirmEmbed], components: [confirmRow] });

        try {
            const confirmation = await confirmMessage.awaitMessageComponent({
                filter: (i: MessageComponentInteraction) => i.user.id === userId && ['confirm_send', 'cancel_send'].includes(i.customId),
                time: 60000
            });

            await confirmation.deferUpdate();

            if (confirmation.customId === 'confirm_send') {
                // Perform the transaction
                const txId = await sendKaspa(userId, BigInt(parseFloat(amount) * 1e8), recipientAddress, network);
                
                let explorerUrl;
                switch (network) {
                    case 'Mainnet':
                        explorerUrl = `https://explorer.kaspa.org/txs/${txId}`;
                        break;
                    case 'Testnet-10':
                        explorerUrl = `https://explorer-tn10.kaspa.org/txs/${txId}`;
                        break;
                    case 'Testnet-11':
                        explorerUrl = `https://explorer-tn11.kaspa.org/txs/${txId}`;
                        break;
                    default:
                        explorerUrl = `Transaction ID: ${txId}`;
                }

                await channel.send(`Transaction completed successfully! View on Explorer here: ${explorerUrl}`);
            } else {
                await channel.send('Transaction cancelled.');
            }
        } catch (interactionError) {
            Logger.error(`Interaction failed for user ${userId}: ${interactionError}`);
            await channel.send('The confirmation interaction failed or timed out. Please try the transaction again.');
        }

    } catch (error) {
        await handleError(error, channel, 'sendKaspaPrompt');
    } finally {
        // Reset the state to WALLET_ACTIONS
        userWalletStates.set(userId, WalletState.WALLET_ACTIONS);
        await promptWalletActions(channel, userId);
    }
};

const checkBalance = async (channel: DMChannel | TextBasedChannel, userId: string) => {
    Logger.info(`Checking balance for user: ${userId}`);
    try {
        if (!checkRateLimit(userId, 'checkBalance')) {
            const remainingTime = getRateLimitRemainingTime(userId, 'checkBalance');
            throw new AppError(
                'Rate limit exceeded',
                `You're checking balance too frequently. Please try again in ${Math.ceil(remainingTime / 1000)} seconds.`,
                'RATE_LIMIT_EXCEEDED'
            );
        }

        const userSession = userSettings.get(userId);
        if (!userSession || !userSession.address) {
            throw new AppError('Invalid wallet', 'Your wallet is not set up correctly. Please create a new wallet.', 'INVALID_WALLET');
        }

        const { kaspaBalance, krc20Balances } = await getBalance(userId, userSession.network);

        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Wallet Balance')
            .setDescription(`Balance for ${userSession.address}`)
            .addFields(
                { name: 'Kaspa Balance', value: kaspaBalance },
                { name: 'KRC20 Tokens', value: krc20Balances.length > 0 ? krc20Balances.join('\n') : 'No KRC20 tokens' }
            )
            .setFooter({ text: `Network: ${userSession.network}` });

        await channel.send({ embeds: [embed] });
        Logger.info(`Balance message sent to user: ${userId}`);
    } catch (error) {
        await handleError(error, channel, 'checkBalance');
    }
};

const showTransactionHistory = async (channel: DMChannel | TextBasedChannel, userId: string) => {
    Logger.info(`Showing transaction history for user: ${userId}`);
    try {
        if (!checkRateLimit(userId, 'showTransactionHistory')) {
            const remainingTime = getRateLimitRemainingTime(userId, 'showTransactionHistory');
            throw new AppError(
                'Rate limit exceeded',
                `You're viewing transaction history too frequently. Please try again in ${Math.ceil(remainingTime / 1000)} seconds.`,
                'RATE_LIMIT_EXCEEDED'
            );
        }

        const userSession = userSettings.get(userId);
        if (!userSession || !userSession.address || !validateAddress(userSession.address)) {
            throw new AppError('Invalid wallet', 'Your wallet address is invalid. Please create a new wallet.', 'INVALID_WALLET');
        }

        const history = await getTransactionHistory(userSession.address, userSession.network);
        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Transaction History')
            .setDescription(`Recent transactions for ${userSession.address}`)
            .setFooter({ text: `Network: ${userSession.network}` });

        history.slice(0, 5).forEach((tx, index) => {
            embed.addFields({ name: `Transaction ${index + 1}`, value: `ID: ${tx.id}\nAmount: ${tx.amount} KAS\nType: ${tx.type}\nTimestamp: ${tx.timestamp}` });
        });

        await channel.send({ embeds: [embed] });
        Logger.info(`Transaction history sent to user: ${userId}`);
    } catch (error) {
        await handleError(error, channel, 'showTransactionHistory');
    }
};

const showHelpMessage = async (channel: DMChannel | TextBasedChannel, userId: string) => {
    Logger.info(`Showing help message for user: ${userId}`);
    try {
        if (!checkRateLimit(userId, 'showHelpMessage')) {
            const remainingTime = getRateLimitRemainingTime(userId, 'showHelpMessage');
            throw new AppError(
                'Rate limit exceeded',
                `You're requesting help messages too frequently. Please try again in ${Math.ceil(remainingTime / 1000)} seconds.`,
                'RATE_LIMIT_EXCEEDED'
            );
        }

        const embed = new EmbedBuilder()
            .setColor(0x0099ff)
            .setTitle('Wallet Help')
            .setDescription('Here are the available wallet commands:')
            .addFields(
                { name: 'Send Kaspa', value: 'Send Kaspa to another address' },
                { name: 'Check Balance', value: 'View your current Kaspa and KRC20 token balances' },
                { name: 'Transaction History', value: 'View your recent transactions' },
                { name: 'Back', value: 'Return to the main wallet menu' }
            )
            .setFooter({ text: 'For more help, visit our documentation or contact support.' });

        await channel.send({ embeds: [embed] });
        Logger.info(`Help message sent to user: ${userId}`);
    } catch (error) {
        await handleError(error, channel, 'showHelpMessage');
    }
};

const clearChatHistory = async (channel: DMChannel | TextBasedChannel, userId: string) => {
    Logger.info(`Clearing chat history for user: ${userId}`);

    try {
        if (!checkRateLimit(userId, 'clearChatHistory')) {
            const remainingTime = getRateLimitRemainingTime(userId, 'clearChatHistory');
            throw new AppError(
                'Rate limit exceeded',
                `You're clearing chat history too frequently. Please try again in ${Math.ceil(remainingTime / 1000)} seconds.`,
                'RATE_LIMIT_EXCEEDED'
            );
        }

        if (channel.type === ChannelType.DM) {
            const messages = await channel.messages.fetch({ limit: 100 });
            const botMessages = messages.filter(m => m.author.id === channel.client.user.id);

            for (const message of botMessages.values()) {
                await message.delete();
            }

            await channel.send('Bot messages have been cleared. For security, please manually delete any of your messages containing sensitive information.');
            Logger.info(`Chat history cleared for user: ${userId}`);
        } else {
            throw new AppError('Invalid Channel', 'Chat history can only be cleared in DM channels.', 'INVALID_CHANNEL_TYPE');
        }
    } catch (error) {
        await handleError(error, channel, 'clearChatHistory');
    }
};

const getTransactionHistory = async (address: string, network: Network): Promise<any[]> => {
    Logger.info(`Fetching transaction history for address: ${address} on network: ${network}`);
    try {
        return await retryableRequest(
            async () => {
                // TODO: Implement this function using the Kaspa WASM bindings
                // This is a placeholder implementation
                return [
                    { id: 'tx1', amount: '10', type: 'Received', timestamp: '2023-04-01 10:00:00' },
                    { id: 'tx2', amount: '5', type: 'Sent', timestamp: '2023-04-02 15:30:00' },
                    // Add more placeholder transactions as needed
                ];
            },
            'Error fetching transaction history'
        );
    } catch (error) {
        throw handleNetworkError(error, 'fetching transaction history');
    }
};