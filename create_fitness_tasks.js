const http = require('http');

const tasks = [
  {
    title: "Wire /workout page to real data with useWorkout hook",
    type: "task",
    tier: "A",
    priority: "critical",
    description: "Implement useWorkout hook for live session tracking. Must handle exercise selection, set logging, rest timers, and completion flow."
  },
  {
    title: "Implement workout logging flow (start → complete sets → finish)",
    type: "task",
    tier: "A",
    priority: "critical",
    description: "Complete the workout session lifecycle: start session, log each set with weight/reps/RPE, handle rest timers, save completion with stats update."
  },
  {
    title: "Wire /programs/builder to real data and implement createProgram",
    type: "task",
    tier: "A",
    priority: "high",
    description: "Build custom program creation UI. Must allow adding exercises, setting day structure, rep/set ranges, progression schemes."
  },
  {
    title: "Implement activity heatmap visualization from database",
    type: "task",
    tier: "B",
    priority: "high",
    description: "Generate heatmap of workout activity. Query workout_logs by date, group by day of week, create visual calendar grid."
  },
  {
    title: "Add profile photo upload and storage",
    type: "task",
    tier: "B",
    priority: "medium",
    description: "Implement image upload to Supabase storage, update user profile with photo URL, add cropping UI."
  },
  {
    title: "Implement push notifications for recovery timers",
    type: "task",
    tier: "B",
    priority: "medium",
    description: "Set up recovery timers for muscle groups, trigger push notifications when recovery is complete using Web Notifications API."
  },
  {
    title: "Add workout history filtering and export",
    type: "task",
    tier: "B",
    priority: "medium",
    description: "Filter workout history by date range, exercise, program. Export to CSV. Add workout analytics dashboard."
  },
  {
    title: "Implement one-rep max calculator with formula validation",
    type: "task",
    tier: "C",
    priority: "low",
    description: "Improve 1RM calculator, add multiple formulas (Epley, Brzycki, Lander), compare results, track 1RM history."
  },
  {
    title: "Add exercise form video library and tutorial links",
    type: "task",
    tier: "C",
    priority: "low",
    description: "Add video URLs to exercises table, display in-app video player, create exercise tutorials section."
  },
  {
    title: "Optimize database queries and add indexes",
    type: "task",
    tier: "B",
    priority: "high",
    description: "Profile slow queries, add indexes on frequently filtered columns (user_id, created_at), optimize pagination."
  }
];

async function createTasks() {
  console.log('\n📋 Creating Fitness Project Tasks...\n');
  
  for (const task of tasks) {
    try {
      const body = JSON.stringify(task);
      const options = {
        hostname: 'localhost',
        port: 3777,
        path: '/api/bounties',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      await new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const result = JSON.parse(data);
              console.log(`✅ Created: ${task.title.substring(0, 50)}... (#${result.id})`);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    } catch (err) {
      console.error(`❌ Failed to create task: ${task.title}`);
      console.error(err.message);
    }
  }
  
  console.log('\n✨ All tasks created!\n');
}

createTasks().catch(console.error);
