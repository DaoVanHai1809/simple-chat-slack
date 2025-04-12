require('dotenv').config();
const express = require('express');
const { WebClient } = require('@slack/web-api');

const app = express();
const port = 3000;
const token = process.env.SLACK_TOKEN;
// Khởi tạo Slack WebClient
const slack = new WebClient(token);

// Middleware để parse JSON
app.use(express.json());

// Biến cache để lưu thông tin users
const userCache = new Map();

// Route xử lý sự kiện từ Slack
app.post('/slack/events', async (req, res) => {
  const { type, challenge, event } = req.body;

  // Xác minh URL với Slack
  if (type === 'url_verification') {
    return res.json({ challenge });
  }

  // Xử lý các sự kiện từ Slack
  if (type === 'event_callback' && event) {
    try {
      // Sự kiện tin nhắn mới
      if (event.type === 'message' && !event.subtype) {
        // Lấy thông tin người dùng (tùy chọn)
        const userInfo = await slack.users.info({ user: event.user });
        const userName = userInfo.user?.name || 'Unknown';

        // Lấy thông tin kênh (tùy chọn)
        const channelInfo = await slack.conversations.info({ channel: event.channel });
        const channelName = channelInfo.channel?.name || 'Unknown';

        // Log tin nhắn mới
        console.log(`New message in #${channelName} from ${userName}: ${event.text}`);

        // Xử lý tin nhắn (ví dụ: lưu vào DB, gửi thông báo, v.v.)
        const messageData = {
          channel: event.channel,
          channelName,
          user: event.user,
          userName,
          text: event.text,
          timestamp: event.ts,
        };

        // TODO: Thêm logic của bạn (lưu DB, gọi API khác, v.v.)
        console.log('Message data:', messageData);

        return res.status(200).json({ success: true });
      }

      // Sự kiện user join channel
      if (event.type === 'member_joined_channel') {
        const { user: userId, channel: channelId } = event;
        console.log(`User ${userId} joined channel ${channelId}`);

        // Lấy thông tin user
        const userResult = await slack.users.info({ user: userId });

        if (userResult.ok) {
          const user = userResult.user;
          const userInfo = {
            id: user.id,
            name: user.name,
            real_name: user.real_name,
            display_name: user.profile.display_name || user.real_name,
            email: user.profile.email || null,
            avatar: user.profile.image_192 || null,
            is_bot: user.is_bot,
            is_admin: user.is_admin || false,
            team_id: user.team_id,
          };

          // Cập nhật userCache
          userCache.set(user.id, userInfo);
          console.log(`Updated userCache with user ${userId}`);
        } else {
          console.error(`Error fetching info for user ${userId}:`, userResult.error);
        }

        return res.status(200).json({ success: true });
      }

      // Sự kiện user thay đổi profile
      if (event.type === 'user_change') {
        const user = event.user;
        const userId = user.id;
        console.log(`User ${userId} changed their profile`);

        // Tạo userInfo từ dữ liệu sự kiện
        const userInfo = {
          id: user.id,
          name: user.name,
          real_name: user.real_name,
          display_name: user.profile.display_name || user.real_name,
          email: user.profile.email || null,
          avatar: user.profile.image_192 || null,
          is_bot: user.is_bot,
          is_admin: user.is_admin || false,
          team_id: user.team_id,
        };

        // Cập nhật userCache
        userCache.set(user.id, userInfo);
        console.log(`Updated userCache with new info for user ${userId}`);

        return res.status(200).json({ success: true });
      }

      // Bỏ qua các sự kiện khác
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error processing event:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // Bỏ qua các request không hợp lệ
  res.status(200).json({ success: true });
});

// Route để lấy danh sách user trong một kênh
app.get('/users/:channelId', async (req, res) => {
  const { channelId } = req.params;

  try {
    // Lấy danh sách thành viên trong kênh
    const membersResult = await slack.conversations.members({
      channel: channelId,
    });

    const memberIds = membersResult.members || [];

    // Lấy thông tin chi tiết của từng user
    const users = await Promise.all(
      memberIds.map(async (userId) => {
        try {
          const userResult = await slack.users.info({
            user: userId,
          });
          const user = userResult.user;
          const userInfo = {
            id: user.id,
            name: user.name,
            real_name: user.real_name,
            display_name: user.profile.display_name || user.real_name,
            email: user.profile.email || null,
            avatar: user.profile.image_192 || null,
            is_bot: user.is_bot,
            is_admin: user.is_admin || false,
            team_id: user.team_id,
          };

          // Lưu user vào cache
          userCache.set(user.id, userInfo);

          return userInfo;
        } catch (error) {
          console.error(`Error fetching info for user ${userId}:`, error);
          return null;
        }
      })
    );

    // Lọc bỏ các user null (nếu có lỗi)
    const validUsers = users.filter((user) => user !== null);

    res.json({
      success: true,
      channel: channelId,
      users: validUsers,
      total: validUsers.length,
    });
  } catch (error) {
    console.error('Error fetching channel members:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      slack_error_code: error.data?.error || null,
    });
  }
});

// Route để crawl tin nhắn từ một kênh
app.get('/crawl/:channelId', async (req, res) => {
  const { channelId } = req.params;
  const { limit, oldest, latest, inclusive, cursor } = req.query;

  try {
    // Gọi API conversations.history với các filter
    const result = await slack.conversations.history({
      channel: channelId,
      limit: parseInt(limit) || 100,
      oldest: oldest || undefined,
      latest: latest || undefined,
      inclusive: inclusive === 'true',
      cursor: cursor || undefined,
    });

    // Map messages và thêm thông tin user từ cache
    const messages = result.messages.map((msg) => {
      const userInfo = userCache.get(msg.user) || {
        id: msg.user,
        name: 'Unknown',
        real_name: 'Unknown',
        display_name: 'Unknown',
        email: null,
        avatar: null,
        is_bot: false,
        is_admin: false,
        team_id: null,
      };

      return {
        user: userInfo,
        text: msg.text,
        timestamp: msg.ts,
      };
    });

    res.json({
      success: true,
      channel: channelId,
      messages,
      total: messages.length,
      has_more: result.has_more || false,
      next_cursor: result.response_metadata?.next_cursor || null,
    });
  } catch (error) {
    console.error('Error crawling messages:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Route để lấy danh sách kênh
app.get('/channels', async (req, res) => {
  try {
    const result = await slack.conversations.list({
      types: 'public_channel,private_channel',
    });

    const channels = result.channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
    }));

    res.json({
      success: true,
      channels,
    });
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Route để gửi tin nhắn
app.post('/send/:channelId', async (req, res) => {
  const { channelId } = req.params;
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({
      success: false,
      error: 'Text is required in the request body',
    });
  }

  try {
    const result = await slack.chat.postMessage({
      channel: channelId,
      text: text,
      as_user: true,
    });

    res.json({
      success: true,
      message: 'Message sent successfully',
      channel: channelId,
      timestamp: result.ts,
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Khởi động server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});