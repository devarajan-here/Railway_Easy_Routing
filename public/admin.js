function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

async function loadAdminStats() {
  const message = document.getElementById('adminMessage');
  try {
    const res = await fetch('/api/auth/admin/stats');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load admin dashboard');

    document.getElementById('totalUsers').textContent = data.totalUsers;
    document.getElementById('completedTours').textContent = data.completedTours;
    document.getElementById('activeSessions').textContent = data.activeSessions;

    const table = document.getElementById('usersTable');
    table.innerHTML = '';
    data.recentUsers.forEach(user => {
      const row = document.createElement('tr');
      [
        user.name,
        user.email,
        user.is_admin ? 'Admin' : 'User',
        user.tour_completed ? 'Completed' : 'Pending',
        formatDate(user.created_at),
        formatDate(user.last_seen_at)
      ].forEach(value => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });
      table.appendChild(row);
    });
  } catch (e) {
    message.textContent = e.message || 'Admin dashboard failed';
  }
}

loadAdminStats();
