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
// Route xử lý sự kiện từ Slack
app.post('/slack/events', async (req, res) => {
  const { type, challenge, event } = req.body;

  // Xác minh URL với Slack 66667777
  if (type === 'url_verification') {
    return res.json({ challenge });
  }

  // Xử lý sự kiện tin nhắn
  if (type === 'event_callback' && event && event.type === 'message' && !event.subtype) {
    try {
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
      // Ví dụ: In ra để kiểm tra
      console.log('Message data:', messageData);

      // Phản hồi 200 để xác nhận nhận sự kiện
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error processing event:', error);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  // Bỏ qua các sự kiện khác
  res.status(200).json({ success: true });
});

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
          return {
            id: user.id,
            name: user.name, // Tên người dùng (username)
            real_name: user.real_name, // Tên thật
            display_name: user.profile.display_name || user.real_name, // Tên hiển thị
            email: user.profile.email || null, // Email (nếu có quyền users:read.email)
            avatar: user.profile.image_192 || null, // URL ảnh đại diện
            is_bot: user.is_bot, // Là bot hay không
            is_admin: user.is_admin || false, // Là admin workspace không
            team_id: user.team_id, // ID team/workspace
          };
        } catch (error) {
          console.error(`Error fetching info for user ${userId}:`, error);
          return null; // Bỏ qua user nếu có lỗi
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
  const {
    limit, // Số lượng tin nhắn tối đa mỗi lần gọi
    oldest, // Tin nhắn từ thời điểm này trở đi
    latest, // Tin nhắn đến thời điểm này
    inclusive, // Bao gồm tin nhắn tại oldest/latest
    cursor // Phân trang
  } = req.query; // Lấy từ query string

  try {
    // Gọi API conversations.history với các filter
    const result = await slack.conversations.history({
      channel: channelId,
      limit: parseInt(limit) || 100, // Mặc định 100 nếu không cung cấp
      oldest: oldest || undefined, // Không đặt nếu không có
      latest: latest || undefined,
      inclusive: inclusive === 'true', // Chuyển string thành boolean
      cursor: cursor || undefined,
    });

    const messages = result.messages.map((msg) => ({
      user: msg.user,
      text: msg.text,
      timestamp: msg.ts,
    }));

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
      types: 'public_channel,private_channel', // Lấy cả kênh công khai và riêng tư
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

app.post('/send/:channelId', async (req, res) => {
    const { channelId } = req.params;
    const { text } = req.body; // Tin nhắn được gửi qua body

    // Kiểm tra xem text có được cung cấp không
    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'Text is required in the request body',
      });
    }

    try {
      // Gọi API chat.postMessage để gửi tin nhắn
      const result = await slack.chat.postMessage({
        channel: channelId,
        text: text,
        as_user: true, // Gửi dưới danh nghĩa bot
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